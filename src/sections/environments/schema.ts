/**
 * The `environments:` schema slice. Imports only zod and the leaf shared helpers, never root
 * schema.ts: that cycle TDZ-crashes at import time on a top-level const.
 *
 * Every rule GitHub enforces on the PUT body, and every combination it accepts but never reads
 * back, is refused here at parse time: both modes reject the document before any section writes.
 * A plan() hook would fire mid-run, after earlier sections wrote.
 */

import { z } from "zod";
import { nestedKnobbed, secretName, variableConfig } from "../shared/schema-helpers.js";

/** GitHub's cap on wait_timer, in minutes (30 days). */
const MAX_WAIT_TIMER_MINUTES = 43_200;

/** GitHub's cap on required reviewers per environment. */
const MAX_REVIEWERS = 6;

/** GitHub's cap on pinned environments per repository. */
export const MAX_PINNED_ENVIRONMENTS = 10;

/**
 * A JSON Schema conditional for the published schema, the one place the keyword pair is spelled.
 * zod refinements do not reach z.toJSONSchema, so each refinement below has a twin here and
 * test/published-schema.test.ts holds the two sides to the same verdicts.
 */
function conditional(
  condition: Record<string, unknown>,
  consequence: Record<string, unknown>,
  otherwise?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    if: condition,
    // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword paired with `if`, not a thenable
    then: consequence,
    ...(otherwise === undefined ? {} : { else: otherwise }),
  };
}

export const DeploymentBranchPolicyConfig = z
  .object({
    name: z.string(),
    type: z.enum(["branch", "tag"]).optional(),
  })
  .meta({ id: "DeploymentBranchPolicyConfig" });
export type DeploymentBranchPolicyConfig = z.infer<typeof DeploymentBranchPolicyConfig>;

export const DeploymentProtectionRuleConfig = z
  .strictObject({
    app: z.string(),
  })
  .meta({ id: "DeploymentProtectionRuleConfig" });
export type DeploymentProtectionRuleConfig = z.infer<typeof DeploymentProtectionRuleConfig>;

export const EnvironmentVariableConfig = variableConfig("EnvironmentVariableConfig");
export type EnvironmentVariableConfig = z.infer<typeof EnvironmentVariableConfig>;

export const EnvironmentSecretConfig = z
  .strictObject({
    name: secretName,
    value: z.string(),
  })
  .meta({ id: "EnvironmentSecretConfig" });
export type EnvironmentSecretConfig = z.infer<typeof EnvironmentSecretConfig>;

/**
 * GitHub accepts exactly one flag on: both true is a 422, and both false is a 422 too because "any
 * branch may deploy" is spelled `deployment_branch_policy: null`.
 */
const DeploymentBranchPolicyFlags = z
  .object({
    protected_branches: z.boolean(),
    custom_branch_policies: z.boolean(),
  })
  .superRefine((flags, refineCtx) => {
    if (flags.protected_branches !== flags.custom_branch_policies) {
      return;
    }
    refineCtx.addIssue({
      code: "custom",
      message: flags.protected_branches
        ? "deployment_branch_policy sets both protected_branches and custom_branch_policies to true, which GitHub rejects: the two flags are mutually exclusive, so set exactly one of them to true"
        : "deployment_branch_policy sets both protected_branches and custom_branch_policies to false, which GitHub rejects: GitHub spells 'any branch may deploy' as deployment_branch_policy: null, so write null",
    });
  })
  .meta(
    conditional(
      { properties: { protected_branches: { const: true } } },
      { properties: { custom_branch_policies: { const: false } } },
      { properties: { custom_branch_policies: { const: true } } },
    ),
  );

export const EnvironmentConfig = z
  .object({
    name: z.string(),
    // Routed (see EnvironmentRoutedScalars): stripped from the PUT body and applied through the
    // GraphQL pin mutations after every PUT.
    pinned: z.boolean().optional(),
    wait_timer: z
      .int("wait_timer is a whole number of minutes")
      .min(0, "wait_timer cannot be negative; 0 declares the wait timer off")
      .max(
        MAX_WAIT_TIMER_MINUTES,
        `GitHub caps wait_timer at ${MAX_WAIT_TIMER_MINUTES} minutes (30 days)`,
      )
      .optional(),
    prevent_self_review: z.boolean().optional(),
    reviewers: z
      .array(z.object({ type: z.enum(["User", "Team"]), id: z.number() }))
      .max(
        MAX_REVIEWERS,
        `GitHub allows at most ${MAX_REVIEWERS} required reviewers per environment; keep ${MAX_REVIEWERS} or fewer entries`,
      )
      .optional(),
    deployment_branch_policy: DeploymentBranchPolicyFlags.nullable().optional(),
    deployment_branch_policies: nestedKnobbed(DeploymentBranchPolicyConfig).optional(),
    deployment_protection_rules: nestedKnobbed(DeploymentProtectionRuleConfig).optional(),
    variables: nestedKnobbed(EnvironmentVariableConfig).optional(),
    secrets: nestedKnobbed(EnvironmentSecretConfig).optional(),
  })
  .superRefine((entry, refineCtx) => {
    // A singular `secret` would ride the passthrough PUT verbatim and configure nothing. The strict
    // type hides the key; only the loosen()ed shape that parses documents lets it reach here.
    if ((entry as Record<string, unknown>).secret !== undefined) {
      refineCtx.addIssue({
        code: "custom",
        path: ["secret"],
        message:
          "environment secrets belong under the entry's `secrets` list, not a singular `secret` key; here it would pass through to the environment PUT verbatim and configure nothing",
      });
    }
    // The flag lives on the required-reviewers rule, and GitHub creates that rule only for a
    // non-empty reviewer list: with none, the flag reads back false and drifts on every run.
    if (entry.prevent_self_review === true && (entry.reviewers ?? []).length === 0) {
      refineCtx.addIssue({
        code: "custom",
        path: ["prevent_self_review"],
        message: `the "${entry.name}" entry declares prevent_self_review: true without reviewers; GitHub keeps the flag only on a required-reviewers rule, which needs at least one reviewer. Declare a reviewer, or write prevent_self_review: false`,
      });
    }
    // The pattern POST would 404 only once the environment PUT had landed, half-applying the run.
    if (
      entry.deployment_branch_policies !== undefined &&
      entry.deployment_branch_policy?.custom_branch_policies !== true
    ) {
      refineCtx.addIssue({
        code: "custom",
        path: ["deployment_branch_policies"],
        message: `the "${entry.name}" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy with custom_branch_policies: true - GitHub rejects every pattern write while the flag is off`,
      });
    }
  })
  .meta({
    id: "EnvironmentConfig",
    allOf: [
      conditional(
        { required: ["deployment_branch_policies"] },
        {
          required: ["deployment_branch_policy"],
          properties: {
            deployment_branch_policy: {
              type: "object",
              required: ["custom_branch_policies"],
              properties: { custom_branch_policies: { const: true } },
            },
          },
        },
      ),
      conditional(
        { required: ["prevent_self_review"], properties: { prevent_self_review: { const: true } } },
        { required: ["reviewers"], properties: { reviewers: { minItems: 1 } } },
      ),
    ],
  });
export type EnvironmentConfig = z.infer<typeof EnvironmentConfig>;

export const EnvironmentsConfig = z.array(EnvironmentConfig).superRefine((entries, refineCtx) => {
  const pinnedIndexes = entries.flatMap((entry, index) => (entry.pinned === true ? [index] : []));
  if (pinnedIndexes.length > MAX_PINNED_ENVIRONMENTS) {
    refineCtx.addIssue({
      code: "custom",
      path: [pinnedIndexes[MAX_PINNED_ENVIRONMENTS] as number, "pinned"],
      message: `the settings file declares ${pinnedIndexes.length} environments with pinned: true, but GitHub allows at most ${MAX_PINNED_ENVIRONMENTS} pinned environments per repository. Declare pinned: true on at most ${MAX_PINNED_ENVIRONMENTS} entries`,
    });
  }
});

/**
 * Where routed-ness is DECLARED: a key here is a scalar the environment PUT does not accept,
 * applied through its own call after the PUT. nested.ts pins its ROUTED_SCALAR_KEYS strip list to
 * these keys in both directions; a routed scalar left among the plain EnvironmentConfig fields
 * would ride the passthrough PUT verbatim and configure nothing.
 */
export type EnvironmentRoutedScalars = Pick<EnvironmentConfig, "pinned">;
