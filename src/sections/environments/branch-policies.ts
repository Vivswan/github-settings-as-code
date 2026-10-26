/**
 * The nested `deployment_branch_policies` key. A pattern's type is immutable upstream, so a type
 * change is a delete plus a recreate.
 */

import { err, ok, Result, safeTry } from "neverthrow";
import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import type { UndeclaredPolicy } from "../../types.js";
import { type DeclaredIssue, duplicateFieldIssues } from "../contract/declared.js";
import { missingDrift, undeclaredDrift, undeclaredNote } from "../contract/drift.js";
import type { SectionFailure } from "../contract/errors.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import type { SectionMeta } from "../contract/module.js";
import { hasDrift, type Read } from "../contract/plan.js";
import {
  type EnvironmentRestOp,
  type EnvironmentsRestContext,
  unreconcilable,
} from "./endpoints.js";
import type { LiveEnvironmentBody } from "./index.js";
import type { NestedPlan } from "./nested.js";
import type { DeploymentBranchPolicyConfig } from "./schema.js";

/** "delete" like the nested variables list: patterns are readable, recreatable configuration. */
export const BRANCH_POLICIES_DEFAULT_POLICY: UndeclaredPolicy = "delete";

// GitHub's spec marks every field optional; a policy without a name fails loudly rather than being skipped, or check would read falsely clean while the delete policy neither removed nor noted it.
const LiveBranchPolicy = z.looseObject({
  id: z.number().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
});

type LiveBranchPolicy = z.infer<typeof LiveBranchPolicy>;

/** "branch" is GitHub's server-side default when the type is absent. */
function livePolicyType(policy: LiveBranchPolicy): string {
  return typeof policy.type === "string" ? policy.type : "branch";
}

const POLICY = { list: "deployment branch-policy", entry: "policy" };

function livePolicyId(policy: LiveBranchPolicy, envName: string): Result<string, SectionFailure> {
  if (policy.id === undefined) {
    return err(unreconcilable(POLICY, envName, "an id"));
  }
  return ok(String(policy.id));
}

function livePolicyName(policy: LiveBranchPolicy, envName: string): Result<string, SectionFailure> {
  if (typeof policy.name !== "string") {
    return err(unreconcilable(POLICY, envName, "a name"));
  }
  return ok(policy.name);
}

/**
 * The live patterns by name under the duplicate-live guard; plan() and snapshot() both index through
 * it, so neither can read two same-named patterns as one. A pattern without a name has no identity
 * to reconcile by, so the listing fails as a whole.
 */
export function policiesByName(
  section: SectionMeta,
  live: readonly LiveBranchPolicy[],
  envName: string,
): Result<Map<string, LiveBranchPolicy>, SectionFailure> {
  return Result.combine(
    live.map((policy) => livePolicyName(policy, envName).map((name) => ({ policy, name }))),
  )
    .andThen((named) =>
      liveByIdentity(
        section,
        "deployment branch policy",
        named,
        (pattern) => pattern.name,
        (pattern) => liveIdentity(pattern.name, { branch_policy_id: pattern.policy.id }),
      ),
    )
    .map((byName) => new Map([...byName].map(([name, pattern]) => [name, pattern.policy])));
}

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
    payload: pattern,
    describe: `creating deployment branch policy "${pattern.name}" in environment "${envName}"`,
  };
}

/**
 * One environment's live patterns. Only meaningful while its custom_branch_policies flag is on:
 * the endpoint 404s otherwise, which the caller reads off the environment body first.
 */
export function listBranchPolicies(
  ctx: EnvironmentsRestContext,
  envName: string,
): Read<LiveBranchPolicy[]> {
  return ctx.read.listPolicies.listAllEnveloped("branch_policies", LiveBranchPolicy, {
    params: { environment_name: envName },
    describe: `environment "${envName}"`,
  });
}

/**
 * Two entries for one pattern could fight over its type on every run. The flag pairing is checked in the
 * zod shape (schema.ts), not here, so both fail before any section writes.
 */
export function duplicateBranchPolicyIssues(
  entries: readonly DeploymentBranchPolicyConfig[],
  envName: string,
): DeclaredIssue[] {
  return duplicateFieldIssues(
    entries,
    { field: "name" },
    `deployment branch policy of the "${envName}" environment`,
  );
}

/**
 * The ops one declared pattern needs: a create when it is missing (unverified while the flag hides
 * the list), a delete plus a recreate when its immutable type differs, none when it matches.
 */
function patternOps(
  envName: string,
  pattern: DeploymentBranchPolicyConfig,
  existing: LiveBranchPolicy | undefined,
  hidden: boolean,
): Result<EnvironmentRestOp[], SectionFailure> {
  const label = `environments[${envName}].deployment_branch_policies[${pattern.name}]`;
  if (!existing) {
    return ok([
      {
        ...createPolicyOp(envName, pattern),
        drift: [
          hidden
            ? `${label}: not verifiable until custom_branch_policies is true; apply will create it once the flag is set`
            : missingDrift(label, { where: "on the environment" }),
        ],
        change: `created deployment branch policy "${pattern.name}" in environment "${envName}"`,
      },
    ]);
  }

  const desiredType = pattern.type ?? "branch";
  const liveType = livePolicyType(existing);
  if (liveType === desiredType) {
    return ok([]);
  }

  const typeDrift = subsetDiff({ type: desiredType }, { type: liveType }, label);
  if (!hasDrift(typeDrift)) {
    throw new Error(
      `BUG: environments: the pattern "${pattern.name}" of environment "${envName}" has a type mismatch (${liveType} vs ${desiredType}) that subsetDiff did not render`,
    );
  }

  return livePolicyId(existing, envName).map((branchPolicyId): EnvironmentRestOp[] => [
    {
      role: "removePolicy",
      params: { environment_name: envName, branch_policy_id: branchPolicyId },
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
  ]);
}

/** A keep-note or the delete for each live pattern the list does not name. */
function undeclaredPolicyOps(
  envName: string,
  liveByName: ReadonlyMap<string, LiveBranchPolicy>,
  declared: ReadonlySet<string>,
  policy: UndeclaredPolicy,
): Result<NestedPlan, SectionFailure> {
  return safeTry(function* () {
    const planned: NestedPlan = { ops: [], notes: [] };
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
        params: {
          environment_name: envName,
          branch_policy_id: yield* livePolicyId(existing, envName),
        },
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
    return ok(planned);
  });
}

/** With custom_branch_policies off the pattern list 404s, so patterns already behind the flag reconcile on the next run. */
export async function planBranchPolicies(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly DeploymentBranchPolicyConfig[],
  liveEnv: LiveEnvironmentBody | undefined,
): Promise<Result<NestedPlan, SectionFailure>> {
  return safeTry(async function* () {
    const planned: NestedPlan = { ops: [], notes: [] };
    const hidden =
      liveEnv !== undefined && liveEnv.deployment_branch_policy?.custom_branch_policies !== true;
    let live: LiveBranchPolicy[] = [];
    if (hidden) {
      // With no list read, preflight never probes listPolicies for this environment, so an
      // Actions-read denial shows up on the next run's read instead of this one's preflight.
      planned.notes.push(
        `environments[${envName}].deployment_branch_policies: patterns are not verifiable until custom_branch_policies is true; apply will set the flag and create the declared patterns, and any pattern already behind the flag reconciles on the next run`,
      );
    } else if (liveEnv !== undefined) {
      live = yield* listBranchPolicies(ctx, envName);
    }
    const liveByName = yield* policiesByName(section, live, envName);
    const declared = new Set(entries.map((pattern) => pattern.name));

    for (const pattern of entries) {
      const ops = yield* patternOps(envName, pattern, liveByName.get(pattern.name), hidden);
      planned.ops.push(...ops);
    }

    const undeclared = yield* undeclaredPolicyOps(envName, liveByName, declared, policy);
    planned.ops.push(...undeclared.ops);
    planned.notes.push(...undeclared.notes);
    return ok(planned);
  });
}
