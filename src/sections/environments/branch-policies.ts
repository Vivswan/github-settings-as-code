/**
 * The nested `deployment_branch_policies` key: reconcile one environment's
 * custom branch-policy patterns (a pattern's type is immutable upstream, so
 * a type change is delete plus recreate).
 */

import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import type { UndeclaredPolicy } from "../../types.js";
import { parseLive } from "../contract/live.js";
import {
  type SectionContext,
  type SectionModule,
  type SectionRun,
  undeclaredDrift,
  undeclaredNote,
} from "../contract/module.js";
import { call, listAllEnveloped } from "../contract/requests.js";
import { ENDPOINTS } from "./endpoints.js";
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
 * Create one branch-policy pattern. GitHub's documented 303 ("a policy with
 * this name pattern already exists" - a race created it between the list and
 * this POST) needs no special handling: the client throws only on 304 and
 * >= 400, and fetch returns a Location-less 303 to the caller, so it arrives
 * here as a plain non-error response and the run converges. Declared keys
 * beyond name/type pass through verbatim.
 */
async function createBranchPolicy(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
  pattern: DeploymentBranchPolicyConfig,
): Promise<void> {
  await call(ctx, section, ENDPOINTS.createPolicy, {
    params: { environment_name: envName },
    payload: pattern,
    describe: `creating deployment branch policy "${pattern.name}" in environment "${envName}"`,
  });
}

/**
 * Reconcile one environment's declared `deployment_branch_policies` list
 * against the live patterns (the autolinks pattern): create missing ones,
 * delete-and-recreate a matching name whose type diverges (type is immutable
 * upstream), and apply the undeclared policy to the rest. In check mode a
 * live environment whose custom_branch_policies flag is off cannot list its
 * patterns (the GET 404s), so the declared list earns a note instead - the
 * environment diff itself already reports the flag drift.
 */
export async function reconcileBranchPolicies(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly DeploymentBranchPolicyConfig[],
  run: SectionRun,
  liveEnv: Record<string, unknown> | undefined,
): Promise<void> {
  if (run.check) {
    const flags = liveEnv?.deployment_branch_policy as
      | { custom_branch_policies?: unknown }
      | null
      | undefined;
    if (flags?.custom_branch_policies !== true) {
      // Returning before the list also means the apply-mode preflight never
      // probes listPolicies for this environment, so an Actions-read denial
      // surfaces only mid-apply, after the environment PUT - the same
      // deliberately accepted shape as the missing-environment case for
      // variables and secrets.
      run.result.notes.push(
        `environments[${envName}].deployment_branch_policies: patterns are not verifiable until custom_branch_policies is true; apply will set the flag and reconcile the declared patterns`,
      );
      return;
    }
  }
  const live = parseLive(
    section,
    ENDPOINTS.listPolicies,
    z.array(LiveBranchPolicy),
    await listAllEnveloped(ctx, section, ENDPOINTS.listPolicies, "branch_policies", {
      params: { environment_name: envName },
    }),
    `environment "${envName}"`,
  );
  const liveByName = new Map<string, LiveBranchPolicy>();
  for (const pattern of live) {
    liveByName.set(livePolicyName(pattern, envName), pattern);
  }
  const declared = new Set(entries.map((pattern) => pattern.name));

  for (const pattern of entries) {
    const label = `environments[${envName}].deployment_branch_policies[${pattern.name}]`;
    const existing = liveByName.get(pattern.name);
    if (!existing) {
      if (run.check) {
        run.result.drift.push(
          `${label}: missing - declared in the settings file but not on the environment; apply will create it`,
        );
      } else {
        await createBranchPolicy(ctx, section, envName, pattern);
        run.result.changes.push(
          `created deployment branch policy "${pattern.name}" in environment "${envName}"`,
        );
      }
      continue;
    }
    const desiredType = pattern.type ?? "branch";
    const liveType = livePolicyType(existing);
    if (liveType === desiredType) {
      continue;
    }
    if (run.check) {
      run.result.drift.push(
        `${label}: the declared type differs from the live pattern's, and a policy's type is immutable; apply will delete and recreate it`,
      );
      // Name the differing values; the generic line alone left the reader
      // guessing which side says what.
      run.result.drift.push(...subsetDiff({ type: desiredType }, { type: liveType }, label));
    } else {
      await call(ctx, section, ENDPOINTS.removePolicy, {
        params: { environment_name: envName, branch_policy_id: livePolicyId(existing, envName) },
        describe: `deleting deployment branch policy "${pattern.name}" in environment "${envName}" to change its immutable type`,
      });
      await createBranchPolicy(ctx, section, envName, pattern);
      run.result.changes.push(
        `replaced deployment branch policy "${pattern.name}" in environment "${envName}" (type is immutable; ${liveType} -> ${desiredType})`,
      );
    }
  }

  for (const [name, existing] of liveByName) {
    if (declared.has(name)) {
      continue;
    }
    if (policy === "keep") {
      run.result.notes.push(
        undeclaredNote({
          subject: `deployment branch policy "${name}"`,
          state: `exists on environment "${envName}" but is not declared`,
          action: "DELETE it",
        }),
      );
    } else if (run.check) {
      run.result.drift.push(
        undeclaredDrift(BRANCH_POLICIES_DEFAULT_POLICY, {
          label: `environments[${envName}].deployment_branch_policies[${name}]`,
          action: "DELETE it",
        }),
      );
    } else {
      await call(ctx, section, ENDPOINTS.removePolicy, {
        params: { environment_name: envName, branch_policy_id: livePolicyId(existing, envName) },
        describe: `deleting undeclared deployment branch policy "${name}" from environment "${envName}"`,
      });
      run.result.changes.push(
        `DELETED undeclared deployment branch policy "${name}" from environment "${envName}"`,
      );
    }
  }
}
