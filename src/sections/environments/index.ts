import { ok, type Result, safeTry } from "neverthrow";
import { z } from "zod";
import {
  omittedDeltas,
  phantomKeys,
  phantomNote,
  refuseOmitted,
  renderDelta,
  subsetDiff,
} from "../../engine/diff.js";
import { declaredEntries, listEntries, secretValuesOf } from "../contract/declared.js";
import { missingDrift } from "../contract/drift.js";
import type { SectionFailure } from "../contract/errors.js";
import { identifiedBy, type KeyedListLayering, keyedBy } from "../contract/keyed-list.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import type { SectionMeta, SectionModule } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { hasDrift } from "../contract/plan.js";
import { layeredList, routed } from "../shared/schema-helpers.js";
import { upperKey } from "../shared/secrets-and-variables/named-scope.js";
import { listSecretValues } from "../shared/secrets-and-variables/secrets-engine.js";
import { projectOntoSchema, replaceSweep } from "../shared/snapshot-helpers.js";
import { ENDPOINTS } from "./endpoints.js";
import {
  NESTED_KEYS,
  nestedDefaultPolicy,
  planNested,
  splitEntry,
  validateNested,
} from "./nested.js";
import {
  type EnvironmentsOp,
  type EnvironmentsPlan,
  type EnvironmentsPlanContext,
  environmentNodeId,
  GRAPHQL_OPS,
  type PinDeclaration,
  planPinned,
  snapshotPins,
} from "./pins.js";
import { EnvironmentConfig, EnvironmentsConfig, environmentKey } from "./schema.js";
import { sharedSecretNotes, snapshotNested, withPins } from "./snapshot.js";

// Every field the section touches is declared here, so an off-shape body fails the read instead of flattenEnvironment's translation or a nested planner's flag read.
const LiveEnvironmentBody = z.looseObject({
  node_id: z.string().optional(),
  protection_rules: z
    .array(
      z.looseObject({
        type: z.string().optional(),
        wait_timer: z.number().optional(),
        prevent_self_review: z.boolean().optional(),
        reviewers: z
          .array(
            z.looseObject({
              type: z.string().optional(),
              reviewer: z.looseObject({ id: z.number() }).optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  deployment_branch_policy: z
    .looseObject({ custom_branch_policies: z.boolean().optional() })
    .nullable()
    .optional(),
});

export type LiveEnvironmentBody = z.infer<typeof LiveEnvironmentBody>;

/** One item of the environment listing: the name plan() probes by is pinned; the id tells two same-fold names apart. */
const LiveEnvironment = LiveEnvironmentBody.extend({ id: z.number().optional(), name: z.string() });

/** The section's default grant, which an endpoint's own permission in ENDPOINTS overrides (the nested lists' do; NESTED_OVERRIDES_CAVEAT names theirs). */
const permission: SectionPermission = { repo: ["environments"] };

// GitHub gates the pattern and protection-rule endpoints outside the Environments permission; appended to the grant so any denial in the section names them.
const NESTED_OVERRIDES_CAVEAT =
  'declared "deployment_branch_policies" and "deployment_protection_rules" keys additionally need "Actions" (read) and "Administration" (read and write)';

// Users and teams number from separate id spaces, so the key is the type:id pair; a removal entry arrives unvalidated, so a non-string type is a keyless entry, never a coerced name.
const REVIEWER_LAYERING: KeyedListLayering = {
  keyField: "id",
  keyKind: "numeric",
  keys: (entry) =>
    typeof entry.id === "number" && typeof entry.type === "string"
      ? [`${entry.type}:${entry.id}`]
      : null,
  removalPaths: ["type", "id"],
};

// Each nested list layers by the key its planner reconciles by; variable and secret names fold uppercase as GitHub stores them, environment names as plan() probes them.
const IDENTITY = identifiedBy("environments", "name", "environment", {
  fold: environmentKey,
  nested: {
    variables: keyedBy("name", {
      fold: upperKey,
      undeclaredDefault: nestedDefaultPolicy("variables"),
    }),
    secrets: keyedBy("name", {
      fold: upperKey,
      undeclaredDefault: nestedDefaultPolicy("secrets"),
    }),
    deployment_branch_policies: keyedBy("name", {
      undeclaredDefault: nestedDefaultPolicy("deployment_branch_policies"),
    }),
    deployment_protection_rules: keyedBy("app", {
      undeclaredDefault: nestedDefaultPolicy("deployment_protection_rules"),
    }),
    reviewers: REVIEWER_LAYERING,
  },
});

/** What one environment's pin mutations resolve their node id from; both closures share the captured id. */
interface PinNodeId {
  /** Fails when the body lacks a node_id; the plan calls it only from a mutation thunk. */
  nodeId: () => Result<string, SectionFailure>;

  /** The PUT's capture hook, present only for a created environment that declares a pin: the response is the id's only source. */
  capture: ((response: unknown) => Result<void, SectionFailure>) | undefined;
}

/** An unknown rule type un-nests generically, or a declared setting of theirs would read as drift; the rule's own envelope keys stay out. */
function unnestRuleSettings(out: Record<string, unknown>, rule: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(rule)) {
    if (!["id", "node_id", "type", "url"].includes(key)) {
      out[key] = value;
    }
  }
}

/**
 * GET nests wait_timer / prevent_self_review / reviewers inside protection_rules[]; translated back
 * to the PUT shape so check compares like with like. Exported so the e2e state tests can assert
 * their environmentFromPut inverts this exact function.
 *
 * An environment without protection answers protection_rules: [], so the disabled values are the
 * baseline and a present rule overwrites its keys: a declared `wait_timer: 0` or `reviewers: []`
 * is satisfied by the absence of the rule, as GitHub itself reads it.
 */
export function flattenEnvironment(live: LiveEnvironmentBody): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...live,
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: [],
  };
  for (const rule of live.protection_rules ?? []) {
    if (rule.type === "wait_timer") {
      out.wait_timer = rule.wait_timer;
      continue;
    }
    if (rule.type === "required_reviewers") {
      const reviewers = rule.reviewers ?? [];
      // The flag counts only with a reviewer to apply it to, the combination the schema accepts.
      out.prevent_self_review = rule.prevent_self_review === true && reviewers.length > 0;
      out.reviewers = reviewers.map((r) => ({ type: r.type, id: r.reviewer?.id }));
      continue;
    }
    unnestRuleSettings(out, rule);
  }
  return out;
}

/**
 * The PUT replaces the environment's settings whole (an omitted `reviewers` clears the reviewers rule), so a
 * non-empty live setting the entry omits is drift too, and the lines it makes (`omitted`) are what apply refuses
 * the write over. The live body is split the way the entry was, so only the PUT's own keys take part in that sweep.
 * The entry passes unknown keys through, so a key the GET never echoes would re-PUT on every apply without
 * converging; `notes` names it. An entry key the GET omits (deployment_branch_policy on an environment that never
 * set one) is drift the PUT resolves, so only a key outside the entry shape is noted. An environment that does
 * not exist yet earns the missing line alone.
 */
function environmentDrift(
  label: string,
  settings: Record<string, unknown>,
  live: LiveEnvironmentBody | undefined,
): { drift: string[]; omitted: string[]; notes: string[] } {
  if (live === undefined) {
    return { drift: [missingDrift(label)], omitted: [], notes: [] };
  }

  const flattened = flattenEnvironment(live);
  const liveSettings = splitEntry(projectOntoSchema(EnvironmentConfig, flattened)).settings;
  const omitted = omittedDeltas(settings, liveSettings, {
    sweep: replaceSweep(EnvironmentConfig),
  }).map((delta) => renderDelta(label, delta));
  const phantom = phantomKeys(settings, flattened).filter(
    (key) => !Object.hasOwn(EnvironmentConfig.shape, key),
  );
  const notes =
    phantom.length > 0 ? [phantomNote(label, phantom, "environment", "this PUT will re-run")] : [];
  return { drift: [...subsetDiff(settings, flattened, label), ...omitted], omitted, notes };
}

/**
 * The node id one environment's pin mutations address: validated off the probe body only when a
 * mutation needs it, or captured from the PUT that creates the environment.
 */
function pinNodeId(
  name: string,
  live: LiveEnvironmentBody | undefined,
  pinned: boolean | undefined,
): PinNodeId {
  const probedNodeId = live === undefined ? undefined : { node_id: live.node_id };
  let createdNodeId: string | undefined;
  const nodeId = (): Result<string, SectionFailure> => {
    if (probedNodeId !== undefined) {
      return environmentNodeId(name, probedNodeId);
    }
    if (createdNodeId === undefined) {
      throw new Error(
        `BUG: environments: the pin of "${name}" ran before the PUT that creates the environment`,
      );
    }
    return ok(createdNodeId);
  };
  const capture =
    live === undefined && pinned !== undefined
      ? (response: unknown) =>
          environmentNodeId(name, response).andThen((id) => {
            createdNodeId = id;
            return ok(undefined);
          })
      : undefined;
  return { nodeId, capture };
}

/**
 * One environment's share of the plan: its PUT when the settings drift, every nested list's ops after
 * it, and the pin its `pinned` key declares.
 */
async function planEnvironment(
  ctx: EnvironmentsPlanContext,
  section: SectionMeta,
  env: EnvironmentConfig,
): Promise<
  Result<
    { ops: EnvironmentsOp[]; notes: string[]; pin: PinDeclaration | undefined },
    SectionFailure
  >
> {
  return safeTry(async function* () {
    const { settings, nested, routed } = splitEntry(env);
    const name = env.name;
    const params = { environment_name: name };
    const probe = yield* ctx.read.probe.probeAbsent(LiveEnvironmentBody, {
      params,
      describe: `environment "${name}"`,
    });
    const live = "missing" in probe ? undefined : probe.data;
    const label = `environments[${name}]`;
    const { drift, omitted, notes: driftNotes } = environmentDrift(label, settings, live);
    const ops: EnvironmentsOp[] = [];
    const notes = [...driftNotes];
    const id = pinNodeId(name, live, routed.pinned);
    if (hasDrift(drift)) {
      ops.push({
        role: "update",
        params,
        payload: settings,
        before: refuseOmitted(label, omitted),
        drift,
        change: `applied environment "${name}"`,
        describe: `upserting environment "${name}"`,
        capture: id.capture,
      });
    }

    for (const key of NESTED_KEYS) {
      const planned = yield* await planNested(ctx, section, key, name, nested, live);
      ops.push(...planned.ops);
      notes.push(...planned.notes);
    }

    const pin =
      routed.pinned === undefined ? undefined : { name, pinned: routed.pinned, nodeId: id.nodeId };
    return ok({ ops, notes, pin });
  });
}

/** The `environments:` section: each entry's PUT, its nested lists after it, and the pins after every environment. */
export const environmentsSection = {
  ...IDENTITY,
  undeclaredDefault: "untouched",
  permission,
  grantCaveat: NESTED_OVERRIDES_CAVEAT,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL_OPS,
  shape: routed(layeredList(EnvironmentsConfig)),
  /** Labels carry the environment: sibling environments can declare same-named secrets. */
  secretValues(declared) {
    return secretValuesOf(declared, (env) =>
      env.secrets === undefined
        ? []
        : listSecretValues(env.secrets).map(({ label, value }) => ({
            label: `${label} of environment "${env.name}"`,
            value,
          })),
    );
  },
  validate(desired) {
    const issues = IDENTITY.validate(desired);
    const { entries: environments, path: at } = declaredEntries(desired);
    environments.forEach((env, index) => {
      issues.push(
        ...validateNested(env).map((issue) => ({ ...issue, path: `${at}[${index}]${issue.path}` })),
      );
    });
    return issues;
  },
  async plan(ctx, desired) {
    const section = this;
    return safeTry(async function* () {
      const plan: EnvironmentsPlan = { ops: [], notes: [], drift: [] };
      /** Each entry's declared pin state, in file order (order IS the pin order). */
      const pins: PinDeclaration[] = [];
      for (const env of listEntries(desired)) {
        const planned = yield* await planEnvironment(ctx, section, env);
        plan.ops.push(...planned.ops);
        plan.notes.push(...planned.notes);
        if (planned.pin !== undefined) {
          pins.push(planned.pin);
        }
      }
      // Pins plan after every environment op: a created environment's id comes from its PUT.
      // Without a `pinned` key the section never touches /graphql.
      if (pins.length > 0) {
        const pinned = yield* planPinned(ctx, pins);
        plan.ops.push(...pinned.ops);
        plan.notes.push(...pinned.notes);
      }
      return ok(plan);
    });
  },
  async snapshot(ctx) {
    const section = this;
    return safeTry(async function* () {
      const listed = yield* ctx.read.list.listAllEnveloped("environments", LiveEnvironment);
      if (listed.length === 0) {
        return ok({ value: undefined, notes: [] });
      }
      yield* liveByIdentity(
        section,
        "environment",
        listed,
        (live) => environmentKey(live.name),
        (live) => liveIdentity(live.name, { environment_id: live.id }),
      );
      const notes: string[] = [];
      const entries: EnvironmentConfig[] = [];
      for (const live of listed) {
        const settings = projectOntoSchema(EnvironmentConfig, flattenEnvironment(live));
        const { nested, notes: nestedNotes } = yield* await snapshotNested(
          ctx,
          section,
          live.name,
          live,
        );
        entries.push({ ...settings, ...nested });
        notes.push(...nestedNotes);
      }
      const pinned = withPins(entries, yield* snapshotPins(ctx));
      notes.push(...pinned.notes, ...sharedSecretNotes(pinned.entries));
      return ok({ value: pinned.entries, notes });
    });
  },
} satisfies SectionModule<"environments", typeof ENDPOINTS, typeof GRAPHQL_OPS>;
