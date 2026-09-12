/**
 * The `environments:` schema slice. Imports only zod and the leaf shared helpers, never root
 * schema.ts: that cycle TDZ-crashes at import time on a top-level const.
 */

import { z } from "zod";
import { nestedKnobbed } from "../shared/schema-helpers.js";

export const DeploymentBranchPolicyConfig = z
  .object({
    name: z.string(),
    // A plain string, not z.enum: GitHub stays the authority on the accepted values, and the
    // meta only documents them in the published schema.
    type: z
      .string()
      .optional()
      .meta({ enum: ["branch", "tag"] }),
  })
  .meta({ id: "DeploymentBranchPolicyConfig" });
export type DeploymentBranchPolicyConfig = z.infer<typeof DeploymentBranchPolicyConfig>;

export const DeploymentProtectionRuleConfig = z
  .strictObject({
    app: z.string(),
  })
  .meta({ id: "DeploymentProtectionRuleConfig" });
export type DeploymentProtectionRuleConfig = z.infer<typeof DeploymentProtectionRuleConfig>;

export const EnvironmentVariableConfig = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .meta({ id: "EnvironmentVariableConfig" });
export type EnvironmentVariableConfig = z.infer<typeof EnvironmentVariableConfig>;

export const EnvironmentSecretConfig = z
  .strictObject({
    name: z.string(),
    value: z.string(),
  })
  .meta({ id: "EnvironmentSecretConfig" });
export type EnvironmentSecretConfig = z.infer<typeof EnvironmentSecretConfig>;

/** GitHub's cap on pinned environments per repository. */
export const MAX_PINNED_ENVIRONMENTS = 10;

export const EnvironmentConfig = z
  .object({
    name: z.string(),
    // Routed (see EnvironmentRoutedScalars): stripped from the PUT body and applied through the
    // GraphQL pin mutations after every PUT.
    pinned: z.boolean().optional(),
    wait_timer: z.number().optional(),
    prevent_self_review: z.boolean().optional(),
    reviewers: z.array(z.object({ type: z.enum(["User", "Team"]), id: z.number() })).optional(),
    deployment_branch_policy: z
      .object({
        protected_branches: z.boolean(),
        custom_branch_policies: z.boolean(),
      })
      .nullable()
      .optional(),
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
    // Checked in the shape, not the section's validate hook, so both modes reject the document
    // before ANY section writes. A hook would fire mid-run, after earlier sections wrote, and the
    // pattern POST would 404 only once the environment PUT had landed, half-applying the run.
    if (entry.deployment_branch_policies === undefined) {
      return;
    }
    if (entry.deployment_branch_policy?.custom_branch_policies !== true) {
      refineCtx.addIssue({
        code: "custom",
        path: ["deployment_branch_policies"],
        message: `the "${entry.name}" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy with custom_branch_policies: true - GitHub rejects every pattern write while the flag is off`,
      });
    }
  })
  .meta({
    id: "EnvironmentConfig",
    if: { required: ["deployment_branch_policies"] },
    // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema conditional keyword paired with `if` above, not a thenable
    then: {
      required: ["deployment_branch_policy"],
      properties: {
        deployment_branch_policy: {
          type: "object",
          required: ["custom_branch_policies"],
          properties: { custom_branch_policies: { const: true } },
        },
      },
    },
  });
export type EnvironmentConfig = z.infer<typeof EnvironmentConfig>;

// The cap is checked in the slice for the same reason as the flag pairing above: rejection before any section writes.
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
