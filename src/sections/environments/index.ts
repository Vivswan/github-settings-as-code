/**
 * `environments:` section - upsert deployment environments by name via PUT.
 * Undeclared environments are left untouched. A declared nested `variables`
 * key reconciles that environment's Actions variables through their own
 * endpoints (undeclared variables WITHIN a declared key are deleted by
 * default; the wrapped `{undeclared: keep, entries}` form softens that to
 * notes). A declared nested `secrets` key reconciles that environment's
 * Actions secrets through the shared secrets engine, one scope per
 * environment (undeclared secrets WITHIN a declared key are KEPT by default
 * - their values are unrecoverable - and `{undeclared: delete, entries}`
 * opts into deletion). A declared nested `deployment_branch_policies` key
 * reconciles that environment's custom branch-policy patterns (it requires
 * the singular `deployment_branch_policy` sibling to set
 * `custom_branch_policies: true`; a pattern's type is immutable upstream, so
 * a type change is delete plus recreate, and undeclared patterns WITHIN a
 * declared key are deleted by default). A declared nested
 * `deployment_protection_rules` key reconciles that environment's custom
 * deployment protection rules - GitHub App gates, enable/disable only,
 * declared by App slug and resolved to the integration id at apply time
 * (undeclared rules WITHIN a declared key are KEPT by default; disabling a
 * deployment gate is security-relevant, so `{undeclared: delete, entries}`
 * opts in).
 */

import { subsetDiff } from "../../engine/diff.js";
import {
  beginRun,
  type DeclaredSecretValue,
  loosen,
  type SectionModule,
  type SectionResult,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { call, probeAbsent, rejectDuplicates } from "../contract/requests.js";
import { listSecretValues } from "../shared/secrets-engine.js";
import { ENDPOINTS } from "./endpoints.js";
import {
  NESTED_KEYS,
  NESTED_RECONCILERS,
  reconcileNested,
  splitEntry,
  validateNested,
} from "./nested.js";
import { GRAPHQL_OPS, type PinDeclaration, pinKey, reconcilePins } from "./pins.js";
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
  async run(ctx, desired): Promise<SectionResult> {
    const run = beginRun(ctx);
    rejectDuplicates(
      this,
      desired,
      (env) => env.name.toLowerCase(),
      (env) => env.name,
    );
    // Validate every nested list upfront, BEFORE any write: a duplicate
    // discovered mid-loop would leave earlier environments applied and later
    // ones untouched.
    for (const env of desired) {
      for (const key of NESTED_KEYS) {
        validateNested(key, env);
      }
    }
    // The node id of each declared environment, captured from the PUT body
    // in apply mode for the pin mutations - the bodies carry the new-format
    // EN_ ids, so no extra lookup is ever needed. Check mode never mutates,
    // so it captures none. Keyed by the section's own case-insensitive
    // natural key.
    const nodeIds = new Map<string, string>();
    const captureNodeId = (name: string, body: unknown): void => {
      const nodeId = (body as { node_id?: unknown } | null)?.node_id;
      if (typeof nodeId === "string") {
        nodeIds.set(pinKey(name), nodeId);
      }
    };
    /** Each entry's declared pin state, in file order (order IS the pin order). */
    const pinDeclarations: PinDeclaration[] = [];
    for (const env of desired) {
      const { settings, nested, routed } = splitEntry(env);
      const name = env.name;
      if (routed.pinned !== undefined) {
        pinDeclarations.push({ name, pinned: routed.pinned });
      }
      if (run.check) {
        const probe = await probeAbsent(ctx, this, ENDPOINTS.probe, {
          params: { environment_name: name },
        });
        if ("missing" in probe) {
          run.result.drift.push(
            `environments[${name}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
          for (const key of NESTED_KEYS) {
            if (nested[key] !== undefined) {
              run.result.notes.push(NESTED_RECONCILERS[key].missingNote(name));
            }
          }
        } else {
          run.result.drift.push(
            ...subsetDiff(settings, flattenEnvironment(probe.data), `environments[${name}]`),
          );
          const liveEnv = (probe.data ?? {}) as Record<string, unknown>;
          for (const key of NESTED_KEYS) {
            await reconcileNested(ctx, this, key, name, nested, run, liveEnv);
          }
        }
      } else {
        const updated = await call(ctx, this, ENDPOINTS.update, {
          params: { environment_name: name },
          payload: settings,
          describe: `upserting environment "${name}"`,
        });
        captureNodeId(name, updated);
        run.result.changes.push(`applied environment "${name}"`);
        for (const key of NESTED_KEYS) {
          await reconcileNested(ctx, this, key, name, nested, run, undefined);
        }
      }
    }
    // Pins reconcile AFTER every environment PUT: a declared pin's node id
    // comes from its own PUT above, and a PUT failure has already aborted
    // the section through the ordinary error flow before any pin mutation
    // could fire. Key-gated: without a declared `pinned` key the section
    // stays REST-only and never touches /graphql.
    if (pinDeclarations.length > 0) {
      await reconcilePins(ctx, this, pinDeclarations, nodeIds, run);
    }
    return run.result;
  },
} satisfies SectionModule<"environments">;

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
