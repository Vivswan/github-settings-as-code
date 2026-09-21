/**
 * The snapshot half of the nested seam: one environment's sub-resource lists read back in their
 * declared wrapped form, each under its planner's own default policy (nestedDefaultPolicy), and
 * the pin state read off the GraphQL pins connection folded onto the entries.
 */

import { ok, type Result, safeTry } from "neverthrow";
import { compareByCodePoint } from "../../engine/canonical.js";
import { snapshotSecretReference } from "../../engine/secrets.js";
import type { UndeclaredPolicyList } from "../../types.js";
import type { SectionFailure } from "../contract/errors.js";
import type { SectionMeta } from "../contract/module.js";
import type { SnapshotContext } from "../contract/plan.js";
import { liveSecretsByKey } from "../shared/secrets-engine.js";
import { projectOntoSchema, readOrNote, unreadableSecretNote } from "../shared/snapshot-helpers.js";
import { liveVariablesByKey } from "../shared/variables-engine.js";
import { listBranchPolicies, policiesByName } from "./branch-policies.js";
import type { ENDPOINTS } from "./endpoints.js";
import type { LiveEnvironmentBody } from "./index.js";
import {
  listEnvironmentSecrets,
  listEnvironmentVariables,
  type NestedKey,
  nestedDefaultPolicy,
} from "./nested.js";
import type { PinnedNames } from "./pins.js";
import { enabledRulesBySlug, listProtectionRules } from "./protection-rules.js";
import {
  DeploymentBranchPolicyConfig,
  type EnvironmentConfig,
  EnvironmentVariableConfig,
} from "./schema.js";

/** The nested keys of one snapshot entry: only the lists with at least one live item appear. */
type NestedSnapshot = Pick<EnvironmentConfig, NestedKey>;

/**
 * The pin state folded onto the entries: the pinned environments lead, in rank order, each with
 * `pinned: true` (the planner reads declaration order as pin order, so any other order would plan
 * a reorder); the rest follow in listing order without the key, since an unpinned environment has
 * nothing to declare and an absent key leaves a pin untouched. A pin naming no listed environment
 * (matched case-insensitively, as GitHub names them) cannot be declared, and the declared pins
 * must lead the live list, so from that rank on no pin is declared; one note names them all.
 */
export function withPins(
  entries: readonly EnvironmentConfig[],
  pins: PinnedNames,
): { entries: EnvironmentConfig[]; notes: string[] } {
  const byKey = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]));
  const leading: EnvironmentConfig[] = [];
  const notes: string[] = [];
  const unlistedAt = pins.findIndex((name) => !byKey.has(name.toLowerCase()));
  const declared = unlistedAt < 0 ? pins : pins.slice(0, unlistedAt);
  for (const name of declared) {
    const entry = byKey.get(name.toLowerCase()) as EnvironmentConfig;
    byKey.delete(name.toLowerCase());
    // The key sits beside the name in the written file, ahead of the nested lists.
    const { name: entryName, ...rest } = entry;
    leading.push({ name: entryName, pinned: true, ...rest });
  }
  if (unlistedAt >= 0) {
    const undeclared = pins.slice(unlistedAt + 1).map((name) => `"${name}"`);
    notes.push(
      `environments: the pinned environment "${pins[unlistedAt]}" is not in the environment listing, so its pin cannot be declared` +
        (undeclared.length === 0
          ? ""
          : `; the pins ranked after it (${undeclared.join(", ")}) are left without the pinned key too, since declared pins must lead the live list`),
    );
  }
  return { entries: [...leading, ...byKey.values()], notes };
}

function wrapped<E>(key: NestedKey, entries: E[]): UndeclaredPolicyList<E> {
  return { _undeclared: nestedDefaultPolicy(key), entries };
}

/**
 * One environment's nested lists read back. The branch policies are listed only while the live
 * flag enables them (the endpoint 404s otherwise); a disabled protection rule is not an active
 * gate, so it is not declared. Each secret becomes a `$NAME` reference with a note asking for it.
 * The policy and rule lists sit behind the Actions grant, not the section's, so a denial there
 * is the key's own: a note under the warn policy, the section's failure under fail.
 */
export async function snapshotNested(
  ctx: SnapshotContext<typeof ENDPOINTS>,
  section: SectionMeta,
  envName: string,
  liveEnv: LiveEnvironmentBody,
): Promise<Result<{ nested: NestedSnapshot; notes: string[] }, SectionFailure>> {
  return safeTry(async function* () {
    const nested: NestedSnapshot = {};
    const notes: string[] = [];
    const variables = [
      ...(yield* listEnvironmentVariables(ctx, envName).andThen((live) =>
        liveVariablesByKey(section, "variable", live),
      )).values(),
    ];
    if (variables.length > 0) {
      nested.variables = wrapped(
        "variables",
        variables.map((variable) => projectOntoSchema(EnvironmentVariableConfig, variable)),
      );
    }
    const secrets = [
      ...(yield* listEnvironmentSecrets(ctx, envName).andThen((live) =>
        liveSecretsByKey(section, `${envName} environment secret`, live),
      )).keys(),
    ];
    if (secrets.length > 0) {
      // The engine's index hands back the uppercase form GitHub stores and the planner compares by,
      // so a lowercase listing still mints a reference the settings-file grammar accepts.
      const references = secrets.map((name) => ({
        name,
        ...snapshotSecretReference(secretStore(envName), name),
      }));
      nested.secrets = wrapped(
        "secrets",
        references.map(({ name, reference }) => ({ name, value: reference })),
      );
      for (const { name, variable } of references) {
        notes.push(
          unreadableSecretNote(`environments[${envName}].secrets[${name}]`, name, variable),
        );
      }
    }
    if (liveEnv.deployment_branch_policy?.custom_branch_policies === true) {
      const policies = yield* await readOrNote(
        ctx,
        notes,
        `environments[${envName}].deployment_branch_policies`,
        () => listBranchPolicies(ctx, envName),
      );
      if ("value" in policies && policies.value.length > 0) {
        const byName = yield* policiesByName(section, policies.value, envName);
        nested.deployment_branch_policies = wrapped(
          "deployment_branch_policies",
          [...byName.values()].map((policy) =>
            projectOntoSchema(DeploymentBranchPolicyConfig, policy),
          ),
        );
      }
    }
    const rules = yield* await readOrNote(
      ctx,
      notes,
      `environments[${envName}].deployment_protection_rules`,
      () => listProtectionRules(ctx, envName),
    );
    if ("value" in rules) {
      const enabled = [...(yield* enabledRulesBySlug(section, rules.value, envName)).keys()];
      if (enabled.length > 0) {
        nested.deployment_protection_rules = wrapped(
          "deployment_protection_rules",
          enabled.map((app) => ({ app })),
        );
      }
    }
    return ok({ nested, notes });
  });
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
      // The owners in code-point order: the listing's order must not reach the note, or an unchanged repository
      // would snapshot two different headers.
      ([variable, labels]) =>
        `secrets: ${[...labels].sort(compareByCodePoint).join(", ")} all read their value from ${variable}; edit a reference to give one its own value`,
    );
}
