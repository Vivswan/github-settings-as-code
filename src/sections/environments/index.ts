import { z } from "zod";
import { omittedDeltas, refuseOmitted, renderDelta, subsetDiff } from "../../engine/diff.js";
import { raise } from "../contract/errors.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  type DeclaredSecretValue,
  type KeyedListLayering,
  keyedBy,
  listEntries,
  loosen,
  missingDrift,
  type SectionModule,
  secretValuesOf,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { hasDrift, plainData } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { layeredList } from "../shared/schema-helpers.js";
import { listSecretValues, secretKey } from "../shared/secrets-engine.js";
import { projectOntoSchema, replaceSweep } from "../shared/snapshot-helpers.js";
import { variableKey } from "../shared/variables-engine.js";
import { ENDPOINTS } from "./endpoints.js";
import { NESTED_KEYS, planNested, splitEntry } from "./nested.js";
import {
  type EnvironmentsPlan,
  environmentNodeId,
  GRAPHQL_OPS,
  type PinDeclaration,
  planPinned,
  snapshotPins,
} from "./pins.js";
import { EnvironmentConfig, EnvironmentsConfig } from "./schema.js";
import { sharedSecretNotes, snapshotNested, withPins } from "./snapshot.js";

/**
 * The environment body (the probe's, and each listing item's): the protection rules GET nests, which
 * flattenEnvironment un-nests, and the branch-policy flags the nested planners read. Every field the
 * section touches is declared, so an off-shape body fails the read instead of a translation.
 */
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

const permission: SectionPermission = { repo: ["environments"] };

// GitHub gates the pattern and protection-rule endpoints outside the Environments permission (per
// the fine-grained permissions reference); appended to the grant so any denial in the section names them.
const NESTED_OVERRIDES_CAVEAT =
  'declared "deployment_branch_policies" and "deployment_protection_rules" keys additionally need "Actions" (read) and "Administration" (read and write)';

/** A reviewer is a `type` and a numeric `id`; users and teams number from separate spaces, so the pair is the key. */
const REVIEWER_LAYERING: KeyedListLayering = {
  keyField: "id",
  keyKind: "numeric",
  keys: (entry) => (typeof entry.id === "number" ? [`${String(entry.type)}:${entry.id}`] : null),
};

export const environmentsSection = {
  key: "environments",
  undeclaredDefault: "untouched",
  permission,
  grantCaveat: NESTED_OVERRIDES_CAVEAT,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL_OPS,
  shape: loosen(layeredList(EnvironmentsConfig)),
  /**
   * Environment names fold as plan() probes them (case-insensitive). The nested lists union by the key each
   * planner reconciles by: variable and secret names uppercased as GitHub stores them, branch policies by their
   * pattern, protection rules by App slug, reviewers by type and id. `deployment_branch_policy: null` is the entry's
   * own "no restriction" value, never a delete marker.
   */
  layering: keyedBy("name", {
    fold: (name) => name.toLowerCase(),
    nullValued: ["deployment_branch_policy"],
    nested: {
      variables: keyedBy("name", { fold: variableKey }),
      secrets: keyedBy("name", { fold: secretKey }),
      deployment_branch_policies: keyedBy("name"),
      deployment_protection_rules: keyedBy("app"),
      reviewers: REVIEWER_LAYERING,
    },
  }),
  /**
   * Labels carry the environment: sibling environments can declare same-named secrets.
   * A malformed container contributes nothing rather than throwing, so the actionable error
   * always comes from shape validation.
   */
  secretValues(declared: unknown): DeclaredSecretValue[] {
    return secretValuesOf(declared, (entry) => {
      const env = entry as EnvironmentConfig;
      const where =
        typeof env.name === "string" ? `environment "${env.name}"` : "an unnamed environment";
      return listSecretValues(env.secrets).map(({ label, value }) => ({
        label: `${label} of ${where}`,
        value,
      }));
    });
  },
  async plan(ctx, desired) {
    const environments = listEntries(desired);
    raise(
      rejectDuplicates(
        this,
        environments,
        (env) => env.name.toLowerCase(),
        (env) => env.name,
      ),
    );
    const plan: EnvironmentsPlan = { ops: [], notes: [], drift: [] };
    /** Each entry's declared pin state, in file order (order IS the pin order). */
    const pins: PinDeclaration[] = [];
    for (const env of environments) {
      const { settings, nested, routed } = splitEntry(env);
      const name = env.name;
      const params = { environment_name: name };
      const probe = await ctx.read.probe.probeAbsent(LiveEnvironmentBody, {
        params,
        describe: `environment "${name}"`,
      });
      const live = "missing" in probe ? undefined : probe.data;
      const label = `environments[${name}]`;
      const { drift, omitted } =
        live === undefined
          ? { drift: [missingDrift(label)], omitted: [] }
          : environmentDrift(label, settings, flattenEnvironment(live));
      // The pin mutations' node id, off the probe or a created environment's PUT response. A probed
      // body is validated only when a mutation needs it.
      const probedNodeId = live === undefined ? undefined : { node_id: live.node_id };
      let createdNodeId: string | undefined;
      const nodeId = (): string => {
        if (probedNodeId !== undefined) {
          return environmentNodeId(name, probedNodeId);
        }
        if (createdNodeId === undefined) {
          throw new Error(
            `BUG: environments: the pin of "${name}" ran before the PUT that creates the environment`,
          );
        }
        return createdNodeId;
      };
      if (hasDrift(drift)) {
        plan.ops.push({
          role: "update",
          params,
          payload: plainData(settings),
          before: refuseOmitted(label, omitted),
          drift,
          change: `applied environment "${name}"`,
          describe: `upserting environment "${name}"`,
          capture:
            live === undefined && routed.pinned !== undefined
              ? (response) => {
                  createdNodeId = environmentNodeId(name, response);
                }
              : undefined,
        });
      }
      if (routed.pinned !== undefined) {
        pins.push({ name, pinned: routed.pinned, nodeId });
      }
      for (const key of NESTED_KEYS) {
        const planned = await planNested(ctx, this, key, name, nested, live);
        plan.ops.push(...planned.ops);
        plan.notes.push(...planned.notes);
      }
    }
    // Pins plan after every environment op: a created environment's id comes from its PUT.
    // Without a `pinned` key the section never touches /graphql.
    if (pins.length > 0) {
      const pinned = await planPinned(ctx, pins);
      plan.ops.push(...pinned.ops);
      plan.notes.push(...pinned.notes);
    }
    return plan;
  },
  async snapshot(ctx) {
    const listed = await ctx.read.list.listAllEnveloped("environments", LiveEnvironment);
    if (listed.length === 0) {
      return { value: undefined, notes: [] };
    }
    // Environment names are case-insensitive on GitHub, the fold plan() probes and pins by.
    raise(
      liveByIdentity(
        this,
        "environment",
        listed,
        (live) => live.name.toLowerCase(),
        (live) => liveIdentity(live.name, { environment_id: live.id }),
      ),
    );
    const notes: string[] = [];
    const entries: EnvironmentConfig[] = [];
    for (const live of listed) {
      const settings = projectOntoSchema(EnvironmentConfig, flattenEnvironment(live));
      const { nested, notes: nestedNotes } = await snapshotNested(ctx, this, live.name, live);
      entries.push({ ...settings, ...nested });
      notes.push(...nestedNotes);
    }
    const pinned = withPins(entries, await snapshotPins(ctx));
    notes.push(...pinned.notes, ...sharedSecretNotes(pinned.entries));
    return { value: pinned.entries, notes };
  },
} satisfies SectionModule<"environments", typeof ENDPOINTS, typeof GRAPHQL_OPS>;

/**
 * The PUT replaces the environment's settings whole (an omitted `reviewers` clears the reviewers rule), so a
 * non-empty live setting the entry omits is drift too, and the lines it makes (`omitted`) are what apply refuses
 * the write over. The live body is split the way the entry was, so only the PUT's own keys take part in that sweep.
 */
function environmentDrift(
  label: string,
  settings: Record<string, unknown>,
  live: Record<string, unknown>,
): { drift: string[]; omitted: string[] } {
  const liveSettings = splitEntry(projectOntoSchema(EnvironmentConfig, live)).settings;
  const omitted = omittedDeltas(settings, liveSettings, {
    sweep: replaceSweep(EnvironmentConfig),
  }).map((delta) => renderDelta(label, delta));
  return { drift: [...subsetDiff(settings, live, label), ...omitted], omitted };
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
    } else if (rule.type === "required_reviewers") {
      const reviewers = rule.reviewers ?? [];
      // The flag counts only with a reviewer to apply it to, the combination the schema accepts.
      out.prevent_self_review = rule.prevent_self_review === true && reviewers.length > 0;
      out.reviewers = reviewers.map((r) => ({ type: r.type, id: r.reviewer?.id }));
    } else {
      // Unknown rule types un-nest generically, or a declared setting of theirs would read as drift.
      for (const [key, value] of Object.entries(rule)) {
        if (!["id", "node_id", "type", "url"].includes(key)) {
          out[key] = value;
        }
      }
    }
  }
  return out;
}
