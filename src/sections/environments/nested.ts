/**
 * The nested planning seam: the NESTED_KEYS/NESTED_PLANNERS table plan()
 * loops over, splitEntry, and the per-environment variables and secrets
 * planners; a missing environment's entries plan as creates without a read.
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import { parseLive } from "../contract/live.js";
import {
  type EntryOf,
  type SectionMeta,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import { hasDrift, plainData } from "../contract/plan.js";
import {
  LIVE_SECRET_NAMES,
  parseSealingKey,
  type SealingKey,
  secretKey,
} from "../shared/secrets-engine.js";
import { LiveVariable, variableKey } from "../shared/variables-engine.js";
import {
  BRANCH_POLICIES_DEFAULT_POLICY,
  planBranchPolicies,
  validateBranchPolicies,
} from "./branch-policies.js";
import { ENDPOINTS, type EnvironmentRestOp, type EnvironmentsRestContext } from "./endpoints.js";
import {
  PROTECTION_RULES_DEFAULT_POLICY,
  planProtectionRules,
  validateProtectionRules,
} from "./protection-rules.js";
import type {
  EnvironmentConfig,
  EnvironmentRoutedScalars,
  EnvironmentSecretConfig,
  EnvironmentVariableConfig,
} from "./schema.js";

/**
 * The per-environment keys that are NOT part of the environment PUT body:
 * each is a sub-resource planned after the PUT by its NESTED_PLANNERS entry;
 * splitEntry strips them so none can leak into the PUT or the environment diff.
 */
export const NESTED_KEYS = [
  "variables",
  "secrets",
  "deployment_branch_policies",
  "deployment_protection_rules",
] as const satisfies readonly (keyof EnvironmentConfig)[];
type NestedKey = (typeof NESTED_KEYS)[number];

/** The declared value of one nested key, once its optionality is peeled off. */
type NestedDeclared = { [K in NestedKey]: NonNullable<EnvironmentConfig[K]> };

/** The entry type of one nested key's list, seen through the wrapped form. */
type NestedEntry<K extends NestedKey> = EntryOf<NestedDeclared[K]>;

/**
 * The EnvironmentConfig keys whose type takes the wrapped
 * `{undeclared, entries}` form. Taking the wrapper is a rule this section
 * commits to for every nested sub-resource list (plain-array PUT fields
 * like `reviewers` never take it), and the guarantee below rests on it:
 * the lockstep types pin NESTED_KEYS to the wrapped keys in both
 * directions, so a wrapped key added to EnvironmentConfig cannot silently
 * leak into the PUT body, and a listed key must really take the wrapper.
 * A nested list declared as a bare array would evade both checks and ride
 * into the PUT unnoticed - give a new key the wrapped form, never a bare
 * array.
 */
type NestedByType = {
  [K in keyof EnvironmentConfig]-?: [
    Extract<NonNullable<EnvironmentConfig[K]>, { entries: readonly unknown[] }>,
  ] extends [never]
    ? never
    : K;
}[keyof EnvironmentConfig];
type _NestedListComplete = MustBeNever<Exclude<NestedByType, NestedKey>>;
type _NestedListSound = MustBeNever<Exclude<NestedKey, NestedByType>>;

/** What one nested planner contributes: its operations, in wire order, and its notes. */
export interface NestedPlan {
  ops: EnvironmentRestOp[];
  notes: string[];
}

/**
 * One nested key's handling, so plan() can loop over NESTED_KEYS instead of
 * branching per key. The table below is a mapped type over NestedKey, so a
 * key added to NESTED_KEYS without a matching entry fails to compile (the
 * section-registry pattern). Function-valued properties on purpose, not
 * method shorthand: method parameters check bivariantly, properties
 * strictly. The strict checking does real work now that the branch-policy
 * entry type differs from the variable/secret ones - a swapped pairing is a
 * compile error, not a runtime surprise.
 */
interface NestedPlanner<K extends NestedKey> {
  /**
   * The policy for live sub-resources WITHIN a declared key that its entries
   * do not declare, the single source every unwrap reads. An explicit
   * value per key on purpose: the section-level default ("untouched")
   * describes sibling ENVIRONMENTS, not the resources inside one, and nested
   * lists never inherit a policy through the multi-repo defaults merge
   * (environment entries merge as whole array elements).
   */
  defaultPolicy: UndeclaredPolicy;
  /**
   * The note beside a declared environment that does not exist yet: its
   * sub-resources cannot be listed, so the declared list plans against an
   * empty environment (every entry a create) instead of a verified one.
   */
  missingNote: (envName: string) => string;
  /**
   * Upfront rejection of misdeclared entries (duplicates, or a cross-key
   * precondition on the rest of the entry), run for ALL environments before
   * any write.
   */
  validate?: (env: EnvironmentConfig, entries: readonly NestedEntry<K>[]) => void;
  /** Plan one environment's declared list against the live sub-resources. */
  plan: (
    ctx: EnvironmentsRestContext,
    section: SectionMeta,
    envName: string,
    policy: UndeclaredPolicy,
    entries: readonly NestedEntry<K>[],
    /**
     * The probed live environment body, or undefined for one the plan creates
     * (its sub-resources 404 until the PUT lands, so the planner reads nothing
     * and plans every entry as a create; branch policies also read its flag).
     */
    liveEnv: Record<string, unknown> | undefined,
  ) => Promise<NestedPlan>;
}

const NESTED_PLANNERS: { [K in NestedKey]: NestedPlanner<K> } = {
  variables: {
    // "delete" like the top-level actions_variables default: variables are
    // readable, recreatable configuration.
    defaultPolicy: "delete",
    missingNote: (envName) =>
      `environments[${envName}].variables: not verifiable while the environment is missing; apply will create the environment and reconcile the declared variables`,
    validate: (env, entries) => rejectDuplicateVariables(env.name, entries),
    plan: planVariables,
  },
  secrets: {
    // "keep" like the top-level secret families: a deleted secret's value is
    // unrecoverable, so deletion is opt-in via the wrapped form.
    defaultPolicy: "keep",
    missingNote: (envName) =>
      `environments[${envName}].secrets: not verifiable while the environment is missing; apply will create the environment and reconcile the declared secrets`,
    validate: (env, entries) => rejectDuplicateSecrets(env.name, entries),
    plan: planEnvironmentSecrets,
  },
  deployment_branch_policies: {
    defaultPolicy: BRANCH_POLICIES_DEFAULT_POLICY,
    missingNote: (envName) =>
      `environments[${envName}].deployment_branch_policies: not verifiable while the environment is missing; apply will create the environment and reconcile the declared patterns`,
    validate: validateBranchPolicies,
    plan: planBranchPolicies,
  },
  deployment_protection_rules: {
    defaultPolicy: PROTECTION_RULES_DEFAULT_POLICY,
    missingNote: (envName) =>
      `environments[${envName}].deployment_protection_rules: not verifiable while the environment is missing; apply will create the environment and reconcile the declared protection rules`,
    validate: validateProtectionRules,
    plan: planProtectionRules,
  },
};

/**
 * Unwrap one nested key's declared value against its own table default.
 * Generic over K so the table lookup and the declared value stay correlated
 * to the same literal key; the union-typed loop variable in plan() cannot
 * express that without casts. The parameter is spelled
 * NonNullable<EnvironmentConfig[K]> rather than the identical
 * NestedDeclared[K]: tsc relates the guarded env[key] to the former
 * directly, while the mapped-type spelling forces a fallback to the
 * intersection over every key, which the differing entry types cannot
 * satisfy. The one cast restates the type in the spelling undeclaredPolicy
 * infers its entry type from.
 */
function unwrapNested<K extends NestedKey>(
  key: K,
  declared: NonNullable<EnvironmentConfig[K]>,
): { policy: UndeclaredPolicy; entries: readonly NestedEntry<K>[] } {
  return undeclaredPolicy(
    declared as readonly NestedEntry<K>[] | UndeclaredPolicyList<NestedEntry<K>>,
    NESTED_PLANNERS[key].defaultPolicy,
  );
}

/** Run one nested key's upfront validation (see NestedPlanner.validate). */
export function validateNested<K extends NestedKey>(key: K, env: EnvironmentConfig): void {
  const declared = env[key];
  if (declared !== undefined) {
    NESTED_PLANNERS[key].validate?.(env, unwrapNested(key, declared).entries);
  }
}

/**
 * Plan one nested key of one environment (generic like validateNested); on a
 * missing environment the missing-environment note joins the planner's creates.
 */
export async function planNested<K extends NestedKey>(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  key: K,
  envName: string,
  nested: Pick<EnvironmentConfig, NestedKey>,
  liveEnv: Record<string, unknown> | undefined,
): Promise<NestedPlan> {
  const declared = nested[key];
  if (declared === undefined) {
    return { ops: [], notes: [] };
  }
  const { policy, entries } = unwrapNested(key, declared);
  const planner = NESTED_PLANNERS[key];
  const planned = await planner.plan(ctx, section, envName, policy, entries, liveEnv);
  return {
    ops: planned.ops,
    notes: liveEnv === undefined ? [planner.missingNote(envName), ...planned.notes] : planned.notes,
  };
}

/**
 * The per-environment SCALAR keys that are NOT part of the environment PUT
 * body: each is applied through its own routed operation (pinned rides the
 * GraphQL pin mutations) after every PUT has landed. splitEntry strips them
 * alongside NESTED_KEYS, so a routed scalar can never leak into the
 * passthrough PUT payload or the check-mode environment diff. The lockstep
 * below is bidirectional like the nested one: the keys are pinned to
 * EnvironmentRoutedScalars (the schema-side interface where routed-ness is
 * DECLARED), so a scalar added to that interface without a strip entry - or
 * listed here without being declared there - fails to compile. A routed
 * scalar declared directly on EnvironmentConfig would evade both checks and
 * ride into the PUT unnoticed - declare it on EnvironmentRoutedScalars,
 * never on the config body.
 */
const ROUTED_SCALAR_KEYS = [
  "pinned",
] as const satisfies readonly (keyof EnvironmentRoutedScalars)[];
type RoutedScalarKey = (typeof ROUTED_SCALAR_KEYS)[number];
type _RoutedScalarsComplete = MustBeNever<Exclude<keyof EnvironmentRoutedScalars, RoutedScalarKey>>;
type _RoutedScalarsSound = MustBeNever<Exclude<RoutedScalarKey, keyof EnvironmentRoutedScalars>>;

/**
 * NESTED_KEYS and ROUTED_SCALAR_KEYS partition the stripped keys: a key in
 * both lists would be stripped twice with whichever handling ran last
 * silently winning, so overlap is a compile error.
 */
type _StripListsDisjoint = MustBeNever<Extract<NestedKey, RoutedScalarKey>>;

/** Split one declared entry into the PUT/diff payload, the nested sub-resources, and the routed scalars. */
export function splitEntry(env: EnvironmentConfig): {
  settings: Record<string, unknown>;
  nested: Pick<EnvironmentConfig, NestedKey>;
  routed: Pick<EnvironmentConfig, RoutedScalarKey>;
} {
  const { name: _name, ...settings } = env;
  const nested: Pick<EnvironmentConfig, NestedKey> = {};
  for (const key of NESTED_KEYS) {
    if (key in settings) {
      (nested as Record<string, unknown>)[key] = settings[key];
      delete settings[key];
    }
  }
  const routed: Pick<EnvironmentConfig, RoutedScalarKey> = {};
  for (const key of ROUTED_SCALAR_KEYS) {
    if (key in settings) {
      (routed as Record<string, unknown>)[key] = settings[key];
      delete settings[key];
    }
  }
  return { settings: settings as Record<string, unknown>, nested, routed };
}

/**
 * Reject two declared variables whose names collapse to the same
 * case-insensitive key: they would fight each other on every run. All
 * colliding pairs are reported at once (the rejectDuplicates posture).
 */
function rejectDuplicateVariables(
  envName: string,
  entries: readonly EnvironmentVariableConfig[],
): void {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const variable of entries) {
    const key = variableKey(variable.name);
    const first = seen.get(key);
    if (first !== undefined) {
      collisions.push(`"${first}" and "${variable.name}"`);
      continue;
    }
    seen.set(key, variable.name);
  }
  if (collisions.length > 0) {
    throw new Error(
      `environments: the "${envName}" entry declares variables that GitHub treats as the same variable (names are case-insensitive): ${collisions.join("; ")}. Keep exactly one entry per variable`,
    );
  }
}

/**
 * Plan one environment's `variables`: create missing, update divergent values
 * and passthrough fields (PATCH at the LIVE name), and apply the undeclared
 * policy to the rest; every line names the environment.
 */
async function planVariables(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly EnvironmentVariableConfig[],
  liveEnv: Record<string, unknown> | undefined,
): Promise<NestedPlan> {
  const params = { environment_name: envName };
  const label = `environments[${envName}].variables`;
  const live =
    liveEnv === undefined
      ? []
      : parseLive(
          section,
          ENDPOINTS.listVariables,
          z.array(LiveVariable),
          await ctx.read.listVariables.listAllEnveloped("variables", { params }),
          `environment "${envName}"`,
        );
  const liveByKey = new Map(live.map((variable) => [variableKey(variable.name), variable]));
  const declaredKeys = new Set(entries.map((variable) => variableKey(variable.name)));
  const planned: NestedPlan = { ops: [], notes: [] };

  for (const variable of entries) {
    const entryLabel = `${label}[${variable.name}]`;
    const existing = liveByKey.get(variableKey(variable.name));
    const { name: _name, value: _value, ...extraKeys } = variable;
    if (!existing) {
      planned.ops.push({
        role: "createVariable",
        params,
        payload: plainData({ name: variable.name, value: variable.value, ...extraKeys }),
        drift: [
          `${entryLabel}: missing - declared in the settings file but not on the environment; apply will create it`,
        ],
        change: `created variable "${variable.name}" in environment "${envName}"`,
        describe: `creating variable "${variable.name}" in environment "${envName}"`,
      });
      continue;
    }
    // The live name never drifts against the declaration: GitHub stores it
    // uppercased whatever casing the file uses, so only the value (and any
    // declared passthrough fields) can diverge.
    const drift = [
      ...(existing.value === variable.value
        ? []
        : [
            `${entryLabel}.value: declared ${JSON.stringify(variable.value)} != live ${JSON.stringify(existing.value)}; apply will set the declared value`,
          ]),
      ...subsetDiff(extraKeys, existing, entryLabel),
    ];
    if (!hasDrift(drift)) {
      continue;
    }
    const phantom = phantomKeys(extraKeys, existing);
    if (phantom.length > 0) {
      planned.notes.push(phantomNote(entryLabel, phantom, "variable", "this update will re-run"));
    }
    planned.ops.push({
      role: "updateVariable",
      params: { ...params, name: existing.name },
      payload: plainData({ value: variable.value, ...extraKeys }),
      drift,
      change: `updated variable "${variable.name}" in environment "${envName}"`,
      describe: `updating variable "${variable.name}" in environment "${envName}"`,
    });
  }

  for (const variable of liveByKey.values()) {
    if (declaredKeys.has(variableKey(variable.name))) {
      continue;
    }
    if (policy === "keep") {
      planned.notes.push(
        undeclaredNote({
          subject: `variable "${variable.name}"`,
          state: `exists on environment "${envName}" but is not declared`,
          action: "DELETE it",
        }),
      );
      continue;
    }
    planned.ops.push({
      role: "removeVariable",
      params: { ...params, name: variable.name },
      drift: [
        undeclaredDrift(NESTED_PLANNERS.variables.defaultPolicy, {
          label: `${label}[${variable.name}]`,
          action: "DELETE it",
        }),
      ],
      change: `DELETED undeclared variable "${variable.name}" from environment "${envName}"`,
      describe: `deleting undeclared variable "${variable.name}" from environment "${envName}"`,
    });
  }
  return planned;
}

/**
 * Reject two declared secrets whose names collapse to the same
 * case-insensitive key (GitHub stores secret names uppercase): they would
 * fight each other on every run. All colliding pairs are reported at once.
 */
function rejectDuplicateSecrets(
  envName: string,
  entries: readonly EnvironmentSecretConfig[],
): void {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const secret of entries) {
    const key = secretKey(secret.name);
    const first = seen.get(key);
    if (first !== undefined) {
      collisions.push(`"${first}" and "${secret.name}"`);
      continue;
    }
    seen.set(key, secret.name);
  }
  if (collisions.length > 0) {
    throw new Error(
      `environments: the "${envName}" entry declares secrets that GitHub treats as the same secret (names are case-insensitive): ${collisions.join("; ")}. Keep exactly one entry per secret`,
    );
  }
}

/**
 * Plan one environment's `secrets`: existence is the only comparable state
 * (a missing name is drift; every declared secret is a sealed alwaysRewrite
 * PUT), and the sealing key is read inside the first thunk, after the PUT.
 */
async function planEnvironmentSecrets(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly EnvironmentSecretConfig[],
  liveEnv: Record<string, unknown> | undefined,
): Promise<NestedPlan> {
  const params = { environment_name: envName };
  const label = `environments[${envName}].secrets`;
  const noun = `${envName} environment secret`;
  const suffix = ` in environment "${envName}"`;
  const live =
    liveEnv === undefined
      ? []
      : parseLive(
          section,
          ENDPOINTS.listSecrets,
          LIVE_SECRET_NAMES,
          await ctx.read.listSecrets.listAllEnveloped("secrets", { params }),
          `environment "${envName}"`,
        );
  // Uppercase key -> the name as the API listed it (already uppercase on real
  // GitHub; normalizing keeps a differently-cased mock or proxy harmless).
  const liveByKey = new Map(live.map((item) => [secretKey(item.name), item.name]));
  const declaredKeys = new Set(entries.map((entry) => secretKey(entry.name)));
  const planned: NestedPlan = { ops: [], notes: [] };

  let sealingKey: Promise<SealingKey> | undefined;
  const readSealingKey = (): Promise<SealingKey> => {
    sealingKey ??= ctx.read.secretsPublicKey
      .call({ params, describe: `reading the ${label} sealing key` })
      .then((body) => parseSealingKey(section, { label }, ENDPOINTS.secretsPublicKey, body));
    return sealingKey;
  };
  for (const entry of entries) {
    const name = secretKey(entry.name);
    const exists = liveByKey.has(name);
    planned.ops.push({
      role: "putSecret",
      params: { ...params, secret_name: name },
      payload: async (exec) => {
        const plaintext = exec.resolveSecret(entry.value);
        return (await readSealingKey()).seal(plaintext);
      },
      drift: exists
        ? []
        : [
            `${label}[${name}]: missing - declared in the settings file but not on the environment; apply will create it`,
          ],
      // Existence from the listing decides the verb; the PUT's own 201/204
      // says the same thing but the executor deliberately does not surface
      // statuses.
      change: `${exists ? "updated" : "created"} secret "${name}"${suffix}`,
      describe: `writing secret "${name}"${suffix}`,
    });
  }
  if (entries.length > 0 && liveEnv !== undefined) {
    // ONE note per environment (the LFS precedent); an environment the plan
    // creates already carries the missing-environment note, which says the
    // same of its whole list.
    planned.notes.push(
      `${noun} values cannot be read back from GitHub, so check mode verifies only that each declared secret exists; apply re-seals and rewrites every declared value on each run`,
    );
  }

  for (const [key, liveName] of liveByKey) {
    if (declaredKeys.has(key)) {
      continue;
    }
    if (policy === "keep") {
      planned.notes.push(
        undeclaredNote({
          subject: `${noun} "${liveName}"`,
          state: "exists on the environment but is not declared",
          action: "DELETE it (a deleted secret's value is unrecoverable)",
        }),
      );
      continue;
    }
    planned.ops.push({
      role: "removeSecret",
      params: { ...params, secret_name: liveName },
      drift: [
        undeclaredDrift(NESTED_PLANNERS.secrets.defaultPolicy, {
          label: `${label}[${liveName}]`,
          action: "DELETE it (the value is unrecoverable)",
        }),
      ],
      change: `DELETED undeclared secret "${liveName}"${suffix}`,
      describe: `deleting undeclared secret "${liveName}"${suffix}`,
    });
  }
  return planned;
}
