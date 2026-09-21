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
import type { SectionFailure } from "../contract/errors.js";

import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  type DeclaredSecretValue,
  declaredEntries,
  duplicateFieldIssues,
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
import { layeredList } from "../shared/schema-helpers.js";
import { listSecretValues, secretKey } from "../shared/secrets-engine.js";
import { projectOntoSchema, replaceSweep } from "../shared/snapshot-helpers.js";
import { variableKey } from "../shared/variables-engine.js";
import { ENDPOINTS } from "./endpoints.js";
import {
  NESTED_KEYS,
  nestedDefaultPolicy,
  planNested,
  splitEntry,
  validateNested,
} from "./nested.js";
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

/**
 * A reviewer is a `type` and a numeric `id`; users and teams number from separate spaces, so the pair is the key. A
 * removal entry reaches here unvalidated (the standalone view drops it before the schema), so the type is read only
 * as a string: a list or mapping there is a keyless entry, not a coerced name.
 */
const REVIEWER_LAYERING: KeyedListLayering = {
  keyField: "id",
  keyKind: "numeric",
  keys: (entry) =>
    typeof entry.id === "number" && typeof entry.type === "string"
      ? [`${entry.type}:${entry.id}`]
      : null,
  removalPaths: ["type", "id"],
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
   * pattern, protection rules by App slug, reviewers by type and id.
   */
  layering: keyedBy("name", {
    fold: (name) => name.toLowerCase(),
    nested: {
      variables: keyedBy("name", {
        fold: variableKey,
        undeclaredDefault: nestedDefaultPolicy("variables"),
      }),
      secrets: keyedBy("name", {
        fold: secretKey,
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
  // Environment names are case-insensitive on GitHub, the fold plan() probes and pins by.
  validate(desired) {
    const issues = duplicateFieldIssues(
      desired,
      { field: "name", fold: (name) => name.toLowerCase() },
      "environment",
    );
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
      const environments = listEntries(desired);
      const plan: EnvironmentsPlan = { ops: [], notes: [], drift: [] };
      /** Each entry's declared pin state, in file order (order IS the pin order). */
      const pins: PinDeclaration[] = [];
      for (const env of environments) {
        const { settings, nested, routed } = splitEntry(env);
        const name = env.name;
        const params = { environment_name: name };
        const probe = yield* ctx.read.probe.probeAbsent(LiveEnvironmentBody, {
          params,
          describe: `environment "${name}"`,
        });
        const live = "missing" in probe ? undefined : probe.data;
        const label = `environments[${name}]`;
        const { drift, omitted, notes } =
          live === undefined
            ? { drift: [missingDrift(label)], omitted: [], notes: [] }
            : environmentDrift(label, settings, flattenEnvironment(live));
        plan.notes.push(...notes);
        // The pin mutations' node id, off the probe or a created environment's PUT response. A probed
        // body is validated only when a mutation needs it.
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
                ? (response) =>
                    environmentNodeId(name, response).andThen((id) => {
                      createdNodeId = id;
                      return ok(undefined);
                    })
                : undefined,
          });
        }
        if (routed.pinned !== undefined) {
          pins.push({ name, pinned: routed.pinned, nodeId });
        }
        for (const key of NESTED_KEYS) {
          const planned = yield* await planNested(ctx, section, key, name, nested, live);
          plan.ops.push(...planned.ops);
          plan.notes.push(...planned.notes);
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
      // Environment names are case-insensitive on GitHub, the fold plan() probes and pins by.
      yield* liveByIdentity(
        section,
        "environment",
        listed,
        (live) => live.name.toLowerCase(),
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

/**
 * The PUT replaces the environment's settings whole (an omitted `reviewers` clears the reviewers rule), so a
 * non-empty live setting the entry omits is drift too, and the lines it makes (`omitted`) are what apply refuses
 * the write over. The live body is split the way the entry was, so only the PUT's own keys take part in that sweep.
 * The entry passes unknown keys through, so a key the GET never echoes would re-PUT on every apply without
 * converging; `notes` names it. An entry key the GET omits (deployment_branch_policy on an environment that never
 * set one) is drift the PUT resolves, so only a key outside the entry shape is noted.
 */
function environmentDrift(
  label: string,
  settings: Record<string, unknown>,
  live: Record<string, unknown>,
): { drift: string[]; omitted: string[]; notes: string[] } {
  const liveSettings = splitEntry(projectOntoSchema(EnvironmentConfig, live)).settings;
  const omitted = omittedDeltas(settings, liveSettings, {
    sweep: replaceSweep(EnvironmentConfig),
  }).map((delta) => renderDelta(label, delta));
  const phantom = phantomKeys(settings, live).filter(
    (key) => !Object.hasOwn(EnvironmentConfig.shape, key),
  );
  const notes =
    phantom.length > 0 ? [phantomNote(label, phantom, "environment", "this PUT will re-run")] : [];
  return { drift: [...subsetDiff(settings, live, label), ...omitted], omitted, notes };
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
