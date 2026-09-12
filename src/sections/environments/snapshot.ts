/**
 * The snapshot half of the nested seam: one environment's sub-resource lists read back in their
 * declared wrapped form, each under its planner's own default policy (nestedDefaultPolicy), and
 * the environment-level GraphQL surface the REST reads cannot carry, as a note.
 */

import { snapshotSecretReference } from "../../engine/secrets.js";
import type { UndeclaredPolicyList } from "../../types.js";
import type { SectionMeta } from "../contract/module.js";
import { secretKey } from "../shared/secrets-engine.js";
import { projectOntoSchema, readOrNote } from "../shared/snapshot-helpers.js";
import { listBranchPolicies } from "./branch-policies.js";
import type { EnvironmentsRestContext } from "./endpoints.js";
import {
  listEnvironmentSecrets,
  listEnvironmentVariables,
  type NestedKey,
  nestedDefaultPolicy,
} from "./nested.js";
import { listProtectionRules, liveRuleSlug } from "./protection-rules.js";
import {
  DeploymentBranchPolicyConfig,
  type EnvironmentConfig,
  EnvironmentVariableConfig,
} from "./schema.js";

/** The nested keys of one snapshot entry: only the lists with at least one live item appear. */
type NestedSnapshot = Pick<EnvironmentConfig, NestedKey>;

export const PINNED_NOTE =
  "pinned rides the GraphQL pins connection, which snapshot does not read; an entry without the key leaves its pin untouched, so declare pinned to manage pins";

function wrapped<E>(key: NestedKey, entries: E[]): UndeclaredPolicyList<E> {
  return { _undeclared: nestedDefaultPolicy(key), entries };
}

/**
 * One environment's nested lists read back. The branch policies are listed only while the live
 * flag enables them (the endpoint 404s otherwise); a disabled protection rule is not an active
 * gate, so it is not declared. Each secret becomes a `$NAME` reference with a note asking for it.
 * The policy and rule lists sit behind the Actions grant, not the section's, so a denial there
 * leaves that key out with a note instead of taking the whole section down.
 */
export async function snapshotNested(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
  liveEnv: Record<string, unknown>,
): Promise<{ nested: NestedSnapshot; notes: string[] }> {
  const nested: NestedSnapshot = {};
  const notes: string[] = [];
  const variables = await listEnvironmentVariables(ctx, section, envName);
  if (variables.length > 0) {
    nested.variables = wrapped(
      "variables",
      variables.map((variable) => projectOntoSchema(EnvironmentVariableConfig, variable)),
    );
  }
  const secrets = await listEnvironmentSecrets(ctx, section, envName);
  if (secrets.length > 0) {
    // Names go through secretKey, the uppercase form GitHub stores and the planner compares by,
    // so a lowercase listing still mints a reference the settings-file grammar accepts.
    const references = secrets.map(({ name }) => ({
      name: secretKey(name),
      ...snapshotSecretReference(secretStore(envName), secretKey(name)),
    }));
    nested.secrets = wrapped(
      "secrets",
      references.map(({ name, reference }) => ({ name, value: reference })),
    );
    for (const { name, variable } of references) {
      notes.push(
        `environments[${envName}].secrets[${name}]: value of ${name} is not readable; export it into the environment as ${variable} before apply`,
      );
    }
  }
  const flags = liveEnv.deployment_branch_policy as { custom_branch_policies?: unknown } | null;
  if (flags?.custom_branch_policies === true) {
    const policies = await readOrNote(
      notes,
      `environments[${envName}].deployment_branch_policies`,
      () => listBranchPolicies(ctx, section, envName),
    );
    if ("value" in policies && policies.value.length > 0) {
      nested.deployment_branch_policies = wrapped(
        "deployment_branch_policies",
        policies.value.map((policy) => projectOntoSchema(DeploymentBranchPolicyConfig, policy)),
      );
    }
  }
  const rules = await readOrNote(
    notes,
    `environments[${envName}].deployment_protection_rules`,
    () => listProtectionRules(ctx, section, envName),
  );
  if ("value" in rules) {
    const enabled = rules.value.filter((rule) => rule.enabled !== false);
    if (enabled.length > 0) {
      nested.deployment_protection_rules = wrapped(
        "deployment_protection_rules",
        enabled.map((rule) => ({ app: liveRuleSlug(rule, envName) })),
      );
    }
  }
  return { nested, notes };
}

/**
 * The store one environment's secret references name (`SECRET_ENVIRONMENT_<NAME>_<SECRET>`): the
 * environment name folded into the reference grammar, so same-named secrets in two environments
 * get two variables. Two names the fold collapses ("prod-1", "prod_1") share one, which
 * sharedSecretNotes reports.
 */
function secretStore(envName: string): string {
  return `environment_${envName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * The note for a variable several secret entries share (two environment names the reference fold
 * collapses): one export would give them all one value.
 */
export function sharedSecretNotes(entries: readonly EnvironmentConfig[]): string[] {
  const owners = new Map<string, string[]>();
  for (const entry of entries) {
    const secrets = entry.secrets;
    if (secrets === undefined || Array.isArray(secrets)) {
      continue;
    }
    for (const secret of secrets.entries) {
      const { variable } = snapshotSecretReference(secretStore(entry.name), secret.name);
      owners.set(variable, [
        ...(owners.get(variable) ?? []),
        `environments[${entry.name}].secrets[${secret.name}]`,
      ]);
    }
  }
  return [...owners]
    .filter(([, labels]) => labels.length > 1)
    .map(
      ([variable, labels]) =>
        `secrets: ${labels.join(", ")} all read their value from ${variable}; edit a reference to give one its own value`,
    );
}
