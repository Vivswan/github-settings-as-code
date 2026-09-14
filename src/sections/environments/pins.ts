/**
 * Pinned environments (the routed `pinned` scalar): the GraphQL operations and the pin/unpin/reorder
 * planning. plan() gates the call on a declared `pinned` key, so a pin-free file never touches /graphql.
 */

import { z } from "zod";
import { agree, countNoun } from "../../text.js";
import { repoVariables } from "../contract/endpoints.js";
import { type GraphqlOpDecl, graphqlOp } from "../contract/graphql.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import type { PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import type { ENDPOINTS } from "./endpoints.js";
import { MAX_PINNED_ENVIRONMENTS } from "./schema.js";

/** The pins selection both pins reads share, so the snapshot's read cannot lag the planner's. */
const PINS_SELECTION =
  "($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }";

const PINS_QUERY = graphqlOp<{ owner: string; repo: string }>()({
  name: "EnvironmentPins",
  kind: "read",
  query: `query EnvironmentPins${PINS_SELECTION}`,
  connection: { path: ["repository", "pinnedEnvironments"] },
  outcomes: {
    ok: "the pinned environments with their 1-based positions",
    NOT_FOUND:
      "the repository is not visible to the token; read as no pins (the denial surfaces on the first pin write)",
  },
});

/**
 * The snapshot's read of the same pins. No write follows a snapshot to surface a denial, so
 * NOT_FOUND is not tolerated here: a concealed denial fails the read with the grant advice.
 */
const PINS_SNAPSHOT = graphqlOp<{ owner: string; repo: string }>()({
  name: "EnvironmentPinsSnapshot",
  kind: "read",
  query: `query EnvironmentPinsSnapshot${PINS_SELECTION}`,
  connection: { path: ["repository", "pinnedEnvironments"] },
  outcomes: { ok: "the pinned environments with their 1-based positions, for the snapshot" },
});

/**
 * Verified live: a new pin lands at the TAIL (so appends are modelled locally), and UNPROCESSABLE
 * is GitHub's cap rejection, the belt under the plan's own gate.
 */
const PIN_ENVIRONMENT = graphqlOp<{ environmentId: string; pinned: boolean }>()({
  name: "PinEnvironment",
  kind: "write",
  query:
    "mutation PinEnvironment($environmentId: ID!, $pinned: Boolean!) { pinEnvironment(input: { environmentId: $environmentId, pinned: $pinned }) { environment { name isPinned } } }",
  outcomes: {
    ok: "the environment was pinned or unpinned",
    UNPROCESSABLE:
      `the repository already holds ${MAX_PINNED_ENVIRONMENTS} pinned environments (GitHub's ` +
      `cap), so this pin was rejected; pins without a pinned declaration are left untouched, so ` +
      `declare pinned: false on entries for some of the currently pinned environments, or unpin ` +
      `them in the GitHub UI`,
  },
});

/**
 * Verified live: the position is a 1-based RANK, and this is the only mutation that renumbers the
 * list (it reads back contiguous afterwards). The reconciler only ever moves a pin LEFT, toward
 * rank 1, where remove-and-insert semantics are unambiguous.
 */
const REORDER_ENVIRONMENT = graphqlOp<{ environmentId: string; position: number }>()({
  name: "ReorderEnvironment",
  kind: "write",
  query:
    "mutation ReorderEnvironment($environmentId: ID!, $position: Int!) { reorderEnvironment(input: { environmentId: $environmentId, position: $position }) { environment { name } } }",
  outcomes: { ok: "the pinned environment moved to its declared position" },
});

export const GRAPHQL_OPS = {
  pins: PINS_QUERY,
  pinsSnapshot: PINS_SNAPSHOT,
  pin: PIN_ENVIRONMENT,
  reorder: REORDER_ENVIRONMENT,
} as const satisfies Record<string, GraphqlOpDecl>;

export type EnvironmentsPlanContext = PlanContext<typeof ENDPOINTS, typeof GRAPHQL_OPS>;

export type EnvironmentsOp = PlannedOp<typeof ENDPOINTS, typeof GRAPHQL_OPS>;

export type EnvironmentsPlan = SectionPlan<EnvironmentsOp>;

export interface PinDeclaration {
  name: string;
  pinned: boolean;
  /** Throws when the body lacks a node_id; the plan calls it only from a mutation thunk. */
  nodeId: () => string;
}

interface LivePin {
  /**
   * Possibly NON-CONTIGUOUS on live GitHub (unpinning leaves a hole, a new pin appends via a
   * monotonic counter, only a reorder renumbers), so only its RANK in the sorted list is compared.
   */
  position: number;
  name: string;
}

/** The pinned environment names in rank order, as the snapshot orders its pinned entries. */
export type PinnedNames = readonly string[];

/**
 * A pin needs a numeric position and a name to reconcile by; silently skipping one would let check
 * report falsely clean while apply reordered blind, so the node schema demands both.
 */
const LivePinNode = z.looseObject({
  position: z.number(),
  environment: z.looseObject({ name: z.string() }),
});

/**
 * A tolerated NOT_FOUND (how GraphQL delivers a fine-grained denial on the repository) reads as
 * "no pins", the same absent posture as the REST probe, so the denial surfaces on the first pin
 * write instead of failing the read pass.
 */
async function listLivePins(ctx: EnvironmentsPlanContext): Promise<LivePin[]> {
  const listed = await ctx.read.pins.listConnection(LivePinNode, repoVariables(ctx));
  if ("error" in listed) {
    return [];
  }
  return rankPins(ctx, listed.items);
}

/** The snapshot's read: the op tolerates no outcome, so a denial throws with the grant advice. */
export async function snapshotPins(ctx: EnvironmentsPlanContext): Promise<PinnedNames> {
  const listed = await ctx.read.pinsSnapshot.listConnection(LivePinNode, repoVariables(ctx));
  if ("error" in listed) {
    throw new Error(
      "BUG: environments: the snapshot pins query declares no tolerated outcome, yet its read returned an error instead of throwing",
    );
  }
  return rankPins(ctx, listed.items).map((pin) => pin.name);
}

/** The pins in rank order, under the duplicate-live guard (one pin per environment, names folded as pinKey folds them). */
function rankPins(
  ctx: EnvironmentsPlanContext,
  nodes: readonly z.infer<typeof LivePinNode>[],
): LivePin[] {
  const pins = nodes
    .map((node) => ({ position: node.position, name: node.environment.name }))
    .sort((a, b) => a.position - b.position);
  liveByIdentity(
    { key: ctx.section },
    "pinned environment",
    pins,
    (pin) => pinKey(pin.name),
    (pin) => liveIdentity(pin.name, { position: pin.position }),
  );
  return pins;
}

/** Environment names are case-insensitive on GitHub. */
function pinKey(name: string): string {
  return name.toLowerCase();
}

/**
 * A PURE computation both modes share: check renders its drift lines from the plan and apply
 * executes exactly its mutations, so the two cannot disagree. Ranks are compared, never the live
 * position numbers (they may carry holes).
 *
 * pinned: true    -> leads the pinned list, in declaration order
 * pinned: false   -> unpinned
 * no declaration  -> never unpinned; moved after the declared block when it sits among the leading ranks
 */
function planPins(
  declarations: readonly PinDeclaration[],
  live: readonly LivePin[],
): {
  unpins: string[];
  pins: string[];
  /** Each a leftward move to a 1-based rank. */
  reorders: Array<{ name: string; rank: number }>;
  interleaved: string[];
  /** The pinned count once the plan has run; the cap is never transiently exceeded. */
  finalCount: number;
  liveOrder: string[];
} {
  const desired = declarations.filter((entry) => entry.pinned).map((entry) => entry.name);
  const desiredKeys = new Set(desired.map(pinKey));
  const unpinKeys = new Set(
    declarations.filter((entry) => !entry.pinned).map((entry) => pinKey(entry.name)),
  );
  const liveKeys = new Set(live.map((pin) => pinKey(pin.name)));

  const unpins = declarations
    .filter((entry) => !entry.pinned && liveKeys.has(pinKey(entry.name)))
    .map((entry) => entry.name);
  const pins = desired.filter((name) => !liveKeys.has(pinKey(name)));

  // The rank order once the unpins are gone and the missing pins have appended at the tail
  // (verified live): the state the reorder loop starts from.
  const postUnpin = live
    .filter((pin) => !unpinKeys.has(pinKey(pin.name)))
    .map((pin) => pinKey(pin.name));
  const order = [...postUnpin, ...pins.map(pinKey)];

  const interleaved = live
    .filter(
      (pin) =>
        !desiredKeys.has(pinKey(pin.name)) &&
        !unpinKeys.has(pinKey(pin.name)) &&
        postUnpin.indexOf(pinKey(pin.name)) < desired.length,
    )
    .map((pin) => pin.name);

  const reorders: Array<{ name: string; rank: number }> = [];
  desired.forEach((name, index) => {
    const key = pinKey(name);
    if (order[index] === key) {
      return;
    }
    reorders.push({ name, rank: index + 1 });
    order.splice(order.indexOf(key), 1);
    order.splice(index, 0, key);
  });

  return {
    unpins,
    pins,
    reorders,
    interleaved,
    finalCount: postUnpin.length + pins.length,
    liveOrder: live.map((pin) => pin.name),
  };
}

/**
 * Resolved by the FIRST pin thunk, after every environment PUT: a body without node_id fails with
 * zero pins half-applied, and a converged pin state never resolves one.
 */
function resolvePinIds(
  declarations: readonly PinDeclaration[],
  names: readonly string[],
): ReadonlyMap<string, string> {
  const byKey = new Map(declarations.map((entry) => [pinKey(entry.name), entry]));
  return new Map(
    names.map((name) => {
      const declaration = byKey.get(pinKey(name));
      if (declaration === undefined) {
        throw new Error(
          `BUG: environments: a pin mutation was planned for "${name}", which no entry declares a pin state for`,
        );
      }
      return [pinKey(name), declaration.nodeId()];
    }),
  );
}

export function environmentNodeId(name: string, body: unknown): string {
  const nodeId = nodeIdField(body);
  if (typeof nodeId !== "string") {
    throw new Error(
      `environments: the environment body for "${name}" carried no node_id, so its pin cannot be reconciled. Check the "api-version" input against the GitHub REST docs for the environments endpoint`,
    );
  }
  return nodeId;
}

function nodeIdField(body: unknown): unknown {
  return (body as { node_id?: unknown } | null | undefined)?.node_id;
}

/**
 * Mutations in cap-safe order: unpins, then pins, then leftward reorders. An overflow is a note
 * in both modes and fails the first pin thunk.
 */
export async function planPinned(
  ctx: EnvironmentsPlanContext,
  declarations: readonly PinDeclaration[],
): Promise<{ ops: EnvironmentsOp[]; notes: string[] }> {
  const desired = declarations.filter((entry) => entry.pinned).map((entry) => entry.name);
  const live = await listLivePins(ctx);
  const plan = planPins(declarations, live);
  const ops: EnvironmentsOp[] = [];
  const notes: string[] = [];

  if (plan.interleaved.length > 0) {
    const count = plan.interleaved.length;
    notes.push(
      `pinned ${agree(count, "environment", "environments")} ${plan.interleaved.map((name) => `"${name}"`).join(", ")} ` +
        `${agree(count, "has", "have")} no pinned declaration in the settings file; ${agree(count, "it stays", "they stay")} pinned ` +
        `(only a pinned: false entry unpins) and apply moves ${agree(count, "it", "them")} after the declared pins`,
    );
  }
  const overflow =
    plan.finalCount > MAX_PINNED_ENVIRONMENTS
      ? `pinning the ${countNoun(plan.pins.length, "declared environment", "declared environments")} not yet pinned would leave ` +
        `${plan.finalCount} environments pinned, but GitHub allows at most ` +
        `${MAX_PINNED_ENVIRONMENTS}. Pins without a pinned declaration are left untouched, so ` +
        `declare pinned: false on entries for some of the currently pinned environments, or ` +
        `unpin them in the GitHub UI`
      : undefined;
  if (overflow !== undefined) {
    notes.push(`apply will fail: ${overflow}`);
  }

  let ids: ReadonlyMap<string, string> | undefined;
  const idOf = (name: string): string => {
    if (overflow !== undefined) {
      throw new Error(`environments: ${overflow}`);
    }
    ids ??= resolvePinIds(declarations, [
      ...plan.unpins,
      ...plan.pins,
      ...plan.reorders.map((reorder) => reorder.name),
    ]);
    const id = ids.get(pinKey(name));
    if (id === undefined) {
      throw new Error(
        `BUG: environments: no node id was resolved for the pin mutation of "${name}"`,
      );
    }
    return id;
  };

  for (const name of plan.unpins) {
    ops.push({
      role: "pin",
      variables: () => ({ environmentId: idOf(name), pinned: false }),
      drift: [
        `environments[${name}].pinned: pinned on the repo but declared pinned: false; apply will unpin it`,
      ],
      change: `unpinned environment "${name}"`,
      describe: `unpinning environment "${name}"`,
    });
  }
  for (const name of plan.pins) {
    ops.push({
      role: "pin",
      variables: () => ({ environmentId: idOf(name), pinned: true }),
      drift: [
        `environments[${name}].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it`,
      ],
      change: `pinned environment "${name}"`,
      describe: `pinning environment "${name}"`,
    });
  }
  plan.reorders.forEach(({ name, rank }, index) => {
    ops.push({
      role: "reorder",
      variables: () => ({ environmentId: idOf(name), position: rank }),
      drift: [
        index === 0
          ? `environments.pinned: the declared pin order is [${desired.join(", ")}] but the live pinned order is ` +
            `[${plan.liveOrder.join(", ")}]; apply will reorder the pins so the declared ones lead in declaration order`
          : `environments.pinned: apply will also move "${name}" to position ${rank} in that reordering`,
      ],
      change: `moved pinned environment "${name}" to position ${rank}`,
      describe: `moving pinned environment "${name}" to position ${rank}`,
    });
  });
  return { ops, notes };
}
