/**
 * The nested `deployment_branch_policies` key: plan one environment's
 * custom branch-policy patterns (a pattern's type is immutable upstream, so
 * a type change is delete plus recreate).
 */

import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import type { UndeclaredPolicy } from "../../types.js";
import { parseLive } from "../contract/live.js";
import { type SectionMeta, undeclaredDrift, undeclaredNote } from "../contract/module.js";
import { hasDrift, plainData } from "../contract/plan.js";
import { ENDPOINTS, type EnvironmentRestOp, type EnvironmentsRestContext } from "./endpoints.js";
import type { NestedPlan } from "./nested.js";
import type { DeploymentBranchPolicyConfig, EnvironmentConfig } from "./schema.js";

// "delete" like the nested variables list: patterns are readable,
// recreatable configuration.
export const BRANCH_POLICIES_DEFAULT_POLICY: UndeclaredPolicy = "delete";

/**
 * The fields of a live branch policy this section reads. GitHub's spec marks
 * every one of them optional, so each is read defensively: a missing type
 * reads as the server-side default "branch", while a missing name or id is a
 * contract break that fails loudly - a policy without a name has no identity
 * to reconcile by, and silently skipping it would let check report falsely
 * clean while the default delete policy neither removed nor noted it.
 */
const LiveBranchPolicy = z.looseObject({
  id: z.number().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
});
type LiveBranchPolicy = z.infer<typeof LiveBranchPolicy>;

/** A live policy's type; "branch" is GitHub's server-side default when absent. */
function livePolicyType(policy: LiveBranchPolicy): string {
  return typeof policy.type === "string" ? policy.type : "branch";
}

/** The id a delete addresses, or a loud error when the response omitted it. */
function livePolicyId(policy: LiveBranchPolicy, envName: string): string {
  if (policy.id === undefined) {
    throw new Error(
      `environments: the deployment branch-policy list for environment "${envName}" returned a policy without an id, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return String(policy.id);
}

/** The name a policy reconciles by, or a loud error when the response omitted it. */
function livePolicyName(policy: LiveBranchPolicy, envName: string): string {
  if (typeof policy.name !== "string") {
    throw new Error(
      `environments: the deployment branch-policy list for environment "${envName}" returned a policy without a name, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return policy.name;
}

/**
 * Upfront rejection of duplicate declared patterns: exact-name matching
 * would fight itself on every run. The flag pairing (a declared
 * `deployment_branch_policies` needs `custom_branch_policies: true` on the
 * sibling) is NOT checked here: it lives in the section's zod shape, so an
 * invalid document fails upfront validation in both modes before ANY
 * section writes - a hook-level check would fire only when this section
 * runs, after earlier sections already wrote.
 */
export function validateBranchPolicies(
  env: EnvironmentConfig,
  entries: readonly DeploymentBranchPolicyConfig[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const pattern of entries) {
    if (seen.has(pattern.name)) {
      duplicates.add(pattern.name);
    }
    seen.add(pattern.name);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `environments: the "${env.name}" entry declares deployment branch polic${duplicates.size === 1 ? "y" : "ies"} ${[...duplicates].map((name) => `"${name}"`).join(", ")} more than once. Keep exactly one entry per pattern`,
    );
  }
}

/**
 * The create of one pattern, minus the drift and change the caller supplies
 * (a plain create, or the second half of a replace). GitHub's 303 for an
 * existing name arrives as a plain non-error response; extra keys pass through.
 */
function createPolicyOp(
  envName: string,
  pattern: DeploymentBranchPolicyConfig,
): Pick<
  Extract<EnvironmentRestOp, { role: "createPolicy" }>,
  "role" | "params" | "payload" | "describe"
> {
  return {
    role: "createPolicy",
    params: { environment_name: envName },
    payload: plainData(pattern),
    describe: `creating deployment branch policy "${pattern.name}" in environment "${envName}"`,
  };
}

/**
 * Plan one environment's patterns: create missing ones, delete-and-recreate a
 * name whose type diverged (immutable upstream), purge or note the rest. With
 * the flag off the list is unreadable, so hidden patterns reconcile next run.
 */
export async function planBranchPolicies(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly DeploymentBranchPolicyConfig[],
  liveEnv: Record<string, unknown> | undefined,
): Promise<NestedPlan> {
  const params = { environment_name: envName };
  const planned: NestedPlan = { ops: [], notes: [] };
  const flags = liveEnv?.deployment_branch_policy as
    | { custom_branch_policies?: unknown }
    | null
    | undefined;
  const hidden = liveEnv !== undefined && flags?.custom_branch_policies !== true;
  let live: LiveBranchPolicy[] = [];
  if (hidden) {
    // No list read here means preflight never probes listPolicies for this
    // environment, so an Actions-read denial surfaces mid-apply - the same
    // accepted shape as the missing-environment case.
    planned.notes.push(
      `environments[${envName}].deployment_branch_policies: patterns are not verifiable until custom_branch_policies is true; apply will set the flag and create the declared patterns, and any pattern already behind the flag reconciles on the next run`,
    );
  } else if (liveEnv !== undefined) {
    live = parseLive(
      section,
      ENDPOINTS.listPolicies,
      z.array(LiveBranchPolicy),
      await ctx.read.listPolicies.listAllEnveloped("branch_policies", { params }),
      `environment "${envName}"`,
    );
  }
  const liveByName = new Map<string, LiveBranchPolicy>();
  for (const pattern of live) {
    liveByName.set(livePolicyName(pattern, envName), pattern);
  }
  const declared = new Set(entries.map((pattern) => pattern.name));

  for (const pattern of entries) {
    const label = `environments[${envName}].deployment_branch_policies[${pattern.name}]`;
    const existing = liveByName.get(pattern.name);
    if (!existing) {
      planned.ops.push({
        ...createPolicyOp(envName, pattern),
        drift: [
          hidden
            ? `${label}: not verifiable until custom_branch_policies is true; apply will create it once the flag is set`
            : `${label}: missing - declared in the settings file but not on the environment; apply will create it`,
        ],
        change: `created deployment branch policy "${pattern.name}" in environment "${envName}"`,
      });
      continue;
    }
    const desiredType = pattern.type ?? "branch";
    const liveType = livePolicyType(existing);
    if (liveType === desiredType) {
      continue;
    }
    // The differing values are named on the recreate; the generic line alone
    // left the reader guessing which side says what.
    const typeDrift = subsetDiff({ type: desiredType }, { type: liveType }, label);
    if (!hasDrift(typeDrift)) {
      throw new Error(
        `BUG: environments: the pattern "${pattern.name}" of environment "${envName}" has a type mismatch (${liveType} vs ${desiredType}) that subsetDiff did not render`,
      );
    }
    planned.ops.push(
      {
        role: "removePolicy",
        params: { ...params, branch_policy_id: livePolicyId(existing, envName) },
        drift: [
          `${label}: the declared type differs from the live pattern's, and a policy's type is immutable; apply will delete and recreate it`,
        ],
        change: `deleted deployment branch policy "${pattern.name}" in environment "${envName}" to change its immutable type (${liveType} -> ${desiredType})`,
        describe: `deleting deployment branch policy "${pattern.name}" in environment "${envName}" to change its immutable type`,
      },
      {
        ...createPolicyOp(envName, pattern),
        drift: typeDrift,
        change: `recreated deployment branch policy "${pattern.name}" in environment "${envName}" as type ${desiredType}`,
      },
    );
  }

  for (const [name, existing] of liveByName) {
    if (declared.has(name)) {
      continue;
    }
    if (policy === "keep") {
      planned.notes.push(
        undeclaredNote({
          subject: `deployment branch policy "${name}"`,
          state: `exists on environment "${envName}" but is not declared`,
          action: "DELETE it",
        }),
      );
      continue;
    }
    planned.ops.push({
      role: "removePolicy",
      params: { ...params, branch_policy_id: livePolicyId(existing, envName) },
      drift: [
        undeclaredDrift(BRANCH_POLICIES_DEFAULT_POLICY, {
          label: `environments[${envName}].deployment_branch_policies[${name}]`,
          action: "DELETE it",
        }),
      ],
      change: `DELETED undeclared deployment branch policy "${name}" from environment "${envName}"`,
      describe: `deleting undeclared deployment branch policy "${name}" from environment "${envName}"`,
    });
  }
  return planned;
}
