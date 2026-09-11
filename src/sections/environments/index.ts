/**
 * `environments:` section - upsert deployment environments by name via PUT
 * (undeclared ones untouched); the nested lists and the routed `pinned`
 * scalar plan per environment after the PUT (see nested.ts and pins.ts).
 */

import { subsetDiff } from "../../engine/diff.js";
import { type DeclaredSecretValue, loosen, type SectionModule } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { hasDrift, plainData } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { listSecretValues } from "../shared/secrets-engine.js";
import { ENDPOINTS } from "./endpoints.js";
import { NESTED_KEYS, planNested, splitEntry, validateNested } from "./nested.js";
import {
  type EnvironmentsPlan,
  environmentNodeId,
  GRAPHQL_OPS,
  nodeIdField,
  type PinDeclaration,
  planPinned,
} from "./pins.js";
import { type EnvironmentConfig, EnvironmentsConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["environments"] };

/**
 * The grant caveat for the branch-policy pattern and protection-rule
 * endpoints, which GitHub gates OUTSIDE the Environments permission
 * (verified against the fine-grained permissions reference): the pattern
 * list and the protection-rule list need Actions read, while the available
 * protection-rule Apps read and the writes of both families need
 * Administration. Appended to the section grant so a denial anywhere in the
 * section names the extra grants.
 */
const NESTED_OVERRIDES_CAVEAT =
  'declared "deployment_branch_policies" and "deployment_protection_rules" keys additionally need "Actions" (read) and "Administration" (read and write)';

export const environmentsSection = {
  key: "environments",
  undeclaredDefault: "untouched",
  permission,
  grantCaveat: NESTED_OVERRIDES_CAVEAT,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL_OPS,
  shape: loosen(EnvironmentsConfig),
  /**
   * The declared value of every entry's secrets list, across all declared
   * environments, for the engine's up-front reference resolution - each
   * label carries the ENVIRONMENT alongside the secret name, since several
   * environments can declare same-named secrets. DEFENSIVE
   * like the shared extractor: a malformed container contributes nothing
   * instead of throwing, so the actionable error always comes from shape
   * validation.
   */
  secretValues(declared: unknown): DeclaredSecretValue[] {
    if (!Array.isArray(declared)) {
      return [];
    }
    return declared.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }
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
    rejectDuplicates(
      this,
      desired,
      (env) => env.name.toLowerCase(),
      (env) => env.name,
    );
    // Validate every nested list before any operation is planned: a duplicate
    // found mid-loop would waste the earlier reads, and apply must never start
    // on a document one entry invalidates.
    for (const env of desired) {
      for (const key of NESTED_KEYS) {
        validateNested(key, env);
      }
    }
    const plan: EnvironmentsPlan = { ops: [], notes: [], drift: [] };
    /** Each entry's declared pin state, in file order (order IS the pin order). */
    const pins: PinDeclaration[] = [];
    for (const env of desired) {
      const { settings, nested, routed } = splitEntry(env);
      const name = env.name;
      const params = { environment_name: name };
      const probe = await ctx.read.probe.probeAbsent({ params });
      const live = "missing" in probe ? undefined : ((probe.data ?? {}) as Record<string, unknown>);
      const drift =
        live === undefined
          ? [
              `environments[${name}]: missing - declared in the settings file but not on the repo; apply will create it`,
            ]
          : subsetDiff(settings, flattenEnvironment(live), `environments[${name}]`);
      // The node id the pin mutations address: the probed body's field, or a
      // created environment's off its PUT response when that operation runs;
      // no body is kept, and a converged pin state never validates it.
      const probedNodeId = live === undefined ? undefined : { node_id: nodeIdField(live) };
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
      // The nested planners are the seam the shared engines' plan-shaped
      // entry points slot into; each contributes its operations after the
      // environment's own, in NESTED_KEYS order.
      for (const key of NESTED_KEYS) {
        const planned = await planNested(ctx, this, key, name, nested, live);
        plan.ops.push(...planned.ops);
        plan.notes.push(...planned.notes);
      }
    }
    // Pins plan after every environment op (a created environment's id comes
    // from its PUT, which runs first). Key-gated: without a `pinned` key the
    // section never touches /graphql.
    if (pins.length > 0) {
      const pinned = await planPinned(ctx, pins);
      plan.ops.push(...pinned.ops);
      plan.notes.push(...pinned.notes);
    }
    return plan;
  },
} satisfies SectionModule<"environments", typeof ENDPOINTS, typeof GRAPHQL_OPS>;

/**
 * GET /environments/{name} nests wait_timer / prevent_self_review / reviewers
 * inside protection_rules[]; translate back into the PUT request shape so
 * check mode compares like with like. Exported so the e2e state tests assert
 * their environmentFromPut transformer inverts this exact function (not a
 * lookalike copy).
 */
export function flattenEnvironment(live: unknown): Record<string, unknown> {
  const raw = (live ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  const rules = (raw.protection_rules ?? []) as Array<Record<string, unknown>>;
  for (const rule of rules) {
    if (rule.type === "wait_timer") {
      out.wait_timer = rule.wait_timer;
    } else if (rule.type === "required_reviewers") {
      if (rule.prevent_self_review !== undefined) {
        out.prevent_self_review = rule.prevent_self_review;
      }
      const reviewers = (rule.reviewers ?? []) as Array<{
        type: unknown;
        reviewer?: { id?: unknown };
      }>;
      out.reviewers = reviewers.map((r) => ({ type: r.type, id: r.reviewer?.id }));
    } else {
      // Future rule types: un-nest their payload keys generically so check
      // mode can compare declared settings instead of reporting false drift.
      for (const [key, value] of Object.entries(rule)) {
        if (!["id", "node_id", "type", "url"].includes(key)) {
          out[key] = value;
        }
      }
    }
  }
  return out;
}
