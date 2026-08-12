/**
 * Pinned environments (the routed `pinned` scalar): the pins GraphQL
 * operations and the pin/unpin/reorder reconciliation. run() gates the
 * reconcile call on a declared `pinned` key, so a pin-free settings file
 * stays REST-only and never touches /graphql.
 */

import { repoVariables } from "../contract/endpoints.js";
import { type GraphqlOpDecl, graphqlOp } from "../contract/graphql.js";
import type { SectionContext, SectionModule, SectionRun } from "../contract/module.js";
import { callGraphql, listGraphqlConnection, tryCallGraphql } from "../contract/requests.js";
import { MAX_PINNED_ENVIRONMENTS } from "./schema.js";

/**
 * The pinned-environments listing: each node is a PinnedEnvironment carrying
 * the ORDERING as its own `position` field (1-based; ordering does NOT live
 * on the Environment object) plus the pinned environment's name. Verified
 * against live GitHub: position numbers may be NON-CONTIGUOUS - unpinning
 * leaves a hole, a new pin appends via a monotonic counter, and only a
 * reorder renormalizes - so positions are consumed as a SORT KEY (rank),
 * never as literal slot numbers. NOT_FOUND is a declared outcome so a
 * fine-grained read denial - which GraphQL delivers as NOT_FOUND on the
 * repository - reads as "no pins", the same absent posture as the section's
 * REST probe (DENIAL_SEMANTICS keeps environments "absent"); the denial then
 * surfaces on the first write, exactly like the environment PUT.
 */
const PINS_QUERY = graphqlOp<{ owner: string; repo: string }>()({
  name: "EnvironmentPins",
  kind: "read",
  query:
    "query EnvironmentPins($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }",
  connection: { path: ["repository", "pinnedEnvironments"] },
  outcomes: {
    ok: "the pinned environments with their 1-based positions",
    NOT_FOUND:
      "the repository is not visible to the token; read as no pins (the denial surfaces on the first pin write)",
  },
});

/**
 * Pin or unpin one environment, addressed by the node id the REST PUT/GET
 * environment bodies carry (the new-format EN_ ids; no deprecated-ID
 * warnings). Verified against live GitHub: a new pin lands at the TAIL of
 * the pinned list (a monotonic position counter; unpinning never renumbers),
 * which is what lets the reconciler model appends locally instead of
 * re-reading. UNPROCESSABLE is a declared outcome: it is how GitHub rejects
 * a pin once the repository already holds MAX_PINNED_ENVIRONMENTS pins,
 * which the handler turns into an actionable error naming the cap and the
 * way to make room.
 */
const PIN_ENVIRONMENT = graphqlOp<{ environmentId: string; pinned: boolean }>()({
  name: "PinEnvironment",
  kind: "write",
  query:
    "mutation PinEnvironment($environmentId: ID!, $pinned: Boolean!) { pinEnvironment(input: { environmentId: $environmentId, pinned: $pinned }) { environment { name isPinned } } }",
  outcomes: {
    ok: "the environment was pinned or unpinned",
    UNPROCESSABLE: `the repository already holds ${MAX_PINNED_ENVIRONMENTS} pinned environments (GitHub's cap), so this pin was rejected`,
  },
});

/**
 * Move one pinned environment to a 1-based RANK; verified against live
 * GitHub, this is also the only mutation that renormalizes the position
 * numbers (the whole list reads back contiguous afterwards). The reconciler
 * only ever moves a pin LEFT (toward rank 1), where remove-and-insert
 * semantics are unambiguous.
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
  pin: PIN_ENVIRONMENT,
  reorder: REORDER_ENVIRONMENT,
} as const satisfies Record<string, GraphqlOpDecl>;

/** One entry's declared pin state, in settings-file order. */
export interface PinDeclaration {
  name: string;
  pinned: boolean;
}

/** The fields of one live pin this section reads off the pins connection. */
interface LivePin {
  /**
   * The ordering sort key. Verified against live GitHub as possibly
   * NON-CONTIGUOUS (unpinning leaves a hole, a new pin appends via a
   * monotonic counter; only a reorder renormalizes), so it is never compared
   * as a literal slot number - only its RANK in the sorted list matters.
   */
  position: number;
  /** The pinned environment's name. */
  name: string;
}

/**
 * One pins-connection node, with the identity fields extracted loudly (the
 * livePolicyName posture): a pin without a numeric position and a name has
 * no identity to reconcile by, and silently skipping it would let check
 * report falsely clean while apply reordered blind.
 */
function livePin(node: unknown): LivePin {
  const pin = node as { position?: unknown; environment?: { name?: unknown } } | null;
  const position = pin?.position;
  const name = pin?.environment?.name;
  if (typeof position !== "number" || typeof name !== "string") {
    throw new Error(
      `environments: the pinned-environments listing returned a pin node this section cannot read (${JSON.stringify(node) ?? String(node)}): it needs a numeric "position" and an "environment.name" string, so the declared pins cannot be reconciled. Check the "api-version" input against the GitHub GraphQL reference for pinnedEnvironments`,
    );
  }
  return { position, name };
}

/**
 * The live pins in rank order (sorted by their position field). A tolerated
 * NOT_FOUND - how GraphQL delivers a fine-grained denial on the repository -
 * reads as "no pins", the same absent posture as the section's REST probe,
 * so the denial surfaces on the first pin write instead of failing the read
 * pass.
 */
async function listLivePins(
  ctx: SectionContext,
  section: SectionModule<"environments">,
): Promise<LivePin[]> {
  const listed = await listGraphqlConnection(ctx, section, PINS_QUERY, repoVariables(ctx));
  if ("error" in listed) {
    return [];
  }
  return listed.items.map(livePin).sort((a, b) => a.position - b.position);
}

/** The pin key: environment names are case-insensitive, like the natural key. */
export function pinKey(name: string): string {
  return name.toLowerCase();
}

/**
 * The complete mutation plan for the declared pin states against one live
 * pinned list - a PURE computation, shared by both modes: check renders its
 * drift lines from the plan and apply executes exactly the plan's mutations,
 * so the two cannot disagree about what apply would do. Semantics: the
 * entries declaring `pinned: true` must LEAD the pinned list in declaration
 * order (compared by rank - live position numbers may carry holes);
 * `pinned: false` unpins; pins with no declared pin state are never
 * unpinned, and when one sits among the leading ranks the declared block
 * claims, apply moves it after them (`interleaved`, surfaced as a note in
 * both modes).
 *
 * The reorders are simulated here against the post-unpin, post-append order:
 * pins append at the TAIL (verified live behavior), and each reorder pulls
 * desired[i] LEFT into rank i+1 - by the time rank i is considered, ranks
 * 0..i-1 already hold desired[0..i-1], so the target can only sit further
 * right, making remove-then-insert semantics unambiguous and one mutation
 * per out-of-place pin sufficient.
 */
function planPins(
  declarations: readonly PinDeclaration[],
  live: readonly LivePin[],
): {
  /** Display names to unpin (declared pinned: false AND live-pinned). */
  unpins: string[];
  /** Display names to pin (declared pinned: true, not live), file order. */
  pins: string[];
  /** The reorder mutations, each a leftward move to a 1-based rank. */
  reorders: Array<{ name: string; rank: number }>;
  /** Live pins with no declared pin state sitting among the leading ranks. */
  interleaved: string[];
  /** The pinned count once the plan has run (never transiently exceeded). */
  finalCount: number;
  /** The live names in rank order, for the order-drift line. */
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

  // The rank order once the unpins are gone and the missing pins have
  // appended at the tail - the exact state the reorder loop starts from.
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
 * Resolve the node id of every environment the plan will mutate, BEFORE the
 * first mutation (the resolve-before-write posture of the protection-rules
 * reconciler): a body that omitted its node_id fails the section here, with
 * zero pins half-applied, instead of on the Nth mutation. The ids are
 * attached to the plan items themselves, so each mutation below carries its
 * own proof and no name-keyed lookup exists to miss.
 */
function resolvePinIds(
  nodeIds: ReadonlyMap<string, string>,
  plan: { unpins: string[]; pins: string[]; reorders: Array<{ name: string; rank: number }> },
): {
  unpins: Array<{ name: string; id: string }>;
  pins: Array<{ name: string; id: string }>;
  reorders: Array<{ name: string; rank: number; id: string }>;
} {
  const idOf = (name: string): string => {
    const nodeId = nodeIds.get(pinKey(name));
    if (nodeId === undefined) {
      throw new Error(
        `environments: the environment body for "${name}" carried no node_id, so its pin cannot be reconciled. Check the "api-version" input against the GitHub REST docs for the environments endpoint`,
      );
    }
    return nodeId;
  };
  return {
    unpins: plan.unpins.map((name) => ({ name, id: idOf(name) })),
    pins: plan.pins.map((name) => ({ name, id: idOf(name) })),
    reorders: plan.reorders.map(({ name, rank }) => ({ name, rank, id: idOf(name) })),
  };
}

/**
 * Reconcile the declared pin states against the live pinned-environments
 * list, AFTER every environment PUT (run() gates the call on a declared
 * `pinned` key, so a pin-free settings file stays REST-only). Both modes
 * read the live pins once and derive everything from planPins; apply then
 * executes the plan in an order that can never transiently exceed GitHub's
 * cap - unpins first, then pins, then the leftward reorders. The final
 * count is gated up front in both modes (the shape's cap counts only
 * DECLARED pins, and live pins nobody declared - never unpinned here - can
 * still overflow it): check surfaces the overflow as a note beside its
 * drift, apply fails before the first mutation. The per-pin UNPROCESSABLE
 * handling stays as the belt for a pin raced in between the read and the
 * mutations.
 */
export async function reconcilePins(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  declarations: readonly PinDeclaration[],
  nodeIds: ReadonlyMap<string, string>,
  run: SectionRun,
): Promise<void> {
  const desired = declarations.filter((entry) => entry.pinned).map((entry) => entry.name);
  const live = await listLivePins(ctx, section);
  const plan = planPins(declarations, live);

  if (plan.interleaved.length > 0) {
    run.result.notes.push(
      `pinned environment(s) ${plan.interleaved.map((name) => `"${name}"`).join(", ")} have no pinned declaration in the settings file; they stay pinned (only a pinned: false entry unpins) and apply moves them after the declared pins`,
    );
  }
  const overflow =
    plan.finalCount > MAX_PINNED_ENVIRONMENTS
      ? `pinning the ${plan.pins.length} declared environment(s) not yet pinned would leave ${plan.finalCount} environments pinned, but GitHub allows at most ${MAX_PINNED_ENVIRONMENTS}. Pins without a pinned declaration are left untouched, so declare pinned: false on entries for some of the currently pinned environments, or unpin them in the GitHub UI`
      : undefined;

  if (run.check) {
    for (const name of plan.pins) {
      run.result.drift.push(
        `environments[${name}].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it`,
      );
    }
    for (const name of plan.unpins) {
      run.result.drift.push(
        `environments[${name}].pinned: pinned on the repo but declared pinned: false; apply will unpin it`,
      );
    }
    if (plan.reorders.length > 0) {
      run.result.drift.push(
        `environments.pinned: the declared pin order is [${desired.join(", ")}] but the live pinned order is [${plan.liveOrder.join(", ")}]; apply will reorder the pins so the declared ones lead in declaration order`,
      );
    }
    if (overflow !== undefined) {
      run.result.notes.push(`apply will fail: ${overflow}`);
    }
    return;
  }

  if (overflow !== undefined) {
    throw new Error(`environments: ${overflow}`);
  }
  if (plan.unpins.length === 0 && plan.pins.length === 0 && plan.reorders.length === 0) {
    return;
  }
  const resolved = resolvePinIds(nodeIds, plan);

  for (const { name, id } of resolved.unpins) {
    await callGraphql(
      ctx,
      section,
      PIN_ENVIRONMENT,
      { environmentId: id, pinned: false },
      { describe: `unpinning environment "${name}"` },
    );
    run.result.changes.push(`unpinned environment "${name}"`);
  }
  for (const { name, id } of resolved.pins) {
    const pinned = await tryCallGraphql(
      ctx,
      section,
      PIN_ENVIRONMENT,
      { environmentId: id, pinned: true },
      { describe: `pinning environment "${name}"` },
    );
    if ("error" in pinned) {
      // The one tolerated outcome is UNPROCESSABLE: the repository's pinned
      // list is full. The settings file cannot fix that by itself (it never
      // unpins environments it does not declare), so name the way out.
      throw new Error(
        `environments: pinning environment "${name}" failed - GRAPHQL ${PIN_ENVIRONMENT.name}: ${pinned.error.status} ${pinned.error.message}. GitHub allows at most ${MAX_PINNED_ENVIRONMENTS} pinned environments, and pins without a pinned declaration are left untouched - declare pinned: false on entries for some of the currently pinned environments, or unpin them in the GitHub UI`,
      );
    }
    run.result.changes.push(`pinned environment "${name}"`);
  }
  for (const { name, rank, id } of resolved.reorders) {
    await callGraphql(
      ctx,
      section,
      REORDER_ENVIRONMENT,
      { environmentId: id, position: rank },
      { describe: `moving pinned environment "${name}" to position ${rank}` },
    );
    run.result.changes.push(`moved pinned environment "${name}" to position ${rank}`);
  }
}
