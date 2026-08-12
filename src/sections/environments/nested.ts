/**
 * The nested reconciliation seam: the NESTED_KEYS/NESTED_RECONCILERS table
 * run() loops over, the routed-scalar strip (splitEntry), and the
 * per-environment `variables` and `secrets` adapters over the shared
 * engines. The branch-policy and protection-rule reconcilers live in their
 * own sibling modules; the table wires them in.
 */

import { z } from "zod";
import type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import { parseLive } from "../contract/live.js";
import {
  type EntryOf,
  type SectionContext,
  type SectionModule,
  type SectionRun,
  undeclaredPolicy,
} from "../contract/module.js";
import { call, listAllEnveloped } from "../contract/requests.js";
import {
  LIVE_SECRET_NAMES,
  reconcileSecrets,
  type SecretsScope,
  type SecretsScopeOps,
  secretKey,
} from "../shared/secrets-engine.js";
import {
  LiveVariable,
  reconcileVariables as reconcileEngineVariables,
  type VariablesScope,
  type VariablesScopeOps,
  variableKey,
} from "../shared/variables-engine.js";
import {
  BRANCH_POLICIES_DEFAULT_POLICY,
  reconcileBranchPolicies,
  validateBranchPolicies,
} from "./branch-policies.js";
import { ENDPOINTS } from "./endpoints.js";
import {
  PROTECTION_RULES_DEFAULT_POLICY,
  reconcileProtectionRules,
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
 * each is a sub-resource with its own endpoint family, reconciled AFTER the
 * PUT succeeds by its NESTED_RECONCILERS entry. splitEntry strips them in
 * one place, so a nested key can never leak into the passthrough PUT
 * payload or the check-mode environment diff. Exported so the docs test can
 * pin the undeclared-policy guide's nested-knob enumeration to this list.
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

/**
 * One nested key's handling, so run() can loop over NESTED_KEYS instead of
 * branching per key. The table below is a mapped type over NestedKey, so a
 * key added to NESTED_KEYS without a matching entry fails to compile (the
 * section-registry pattern). Function-valued properties on purpose, not
 * method shorthand: method parameters check bivariantly, properties
 * strictly. The strict checking does real work now that the branch-policy
 * entry type differs from the variable/secret ones - a swapped pairing is a
 * compile error, not a runtime surprise.
 */
interface NestedReconciler<K extends NestedKey> {
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
   * Check-mode note when the declared environment does not exist yet:
   * listing a missing environment's sub-resources is impossible, so the
   * declared list cannot be verified until the environment exists, and the
   * missing-environment drift already fails check.
   */
  missingNote: (envName: string) => string;
  /**
   * Upfront rejection of misdeclared entries (duplicates, or a cross-key
   * precondition on the rest of the entry), run for ALL environments before
   * any write.
   */
  validate?: (env: EnvironmentConfig, entries: readonly NestedEntry<K>[]) => void;
  /** Reconcile one environment's declared list against the live sub-resources. */
  reconcile: (
    ctx: SectionContext,
    section: SectionModule<"environments">,
    envName: string,
    policy: UndeclaredPolicy,
    entries: readonly NestedEntry<K>[],
    run: SectionRun,
    /**
     * The probed live environment body, present in CHECK mode only: the
     * branch-policy reconciler reads its custom_branch_policies flag to know
     * whether the pattern list is even readable. Apply mode passes undefined
     * on purpose - the PUT that just ran defines the live flags there, and
     * the shape's flag-pairing refinement guarantees the declared flag is
     * true.
     */
    liveEnv: Record<string, unknown> | undefined,
  ) => Promise<void>;
}

export const NESTED_RECONCILERS: { [K in NestedKey]: NestedReconciler<K> } = {
  variables: {
    // "delete" like the top-level actions_variables default: variables are
    // readable, recreatable configuration.
    defaultPolicy: "delete",
    missingNote: (envName) =>
      `environments[${envName}].variables: not verifiable while the environment is missing; apply will create the environment and reconcile the declared variables`,
    validate: (env, entries) => rejectDuplicateVariables(env.name, entries),
    reconcile: reconcileVariables,
  },
  secrets: {
    // "keep" like the top-level secret families: a deleted secret's value is
    // unrecoverable, so deletion is opt-in via the wrapped form.
    defaultPolicy: "keep",
    missingNote: (envName) =>
      `environments[${envName}].secrets: not verifiable while the environment is missing; apply will create the environment and reconcile the declared secrets`,
    validate: (env, entries) => rejectDuplicateSecrets(env.name, entries),
    reconcile: reconcileEnvironmentSecrets,
  },
  deployment_branch_policies: {
    defaultPolicy: BRANCH_POLICIES_DEFAULT_POLICY,
    missingNote: (envName) =>
      `environments[${envName}].deployment_branch_policies: not verifiable while the environment is missing; apply will create the environment and reconcile the declared patterns`,
    validate: validateBranchPolicies,
    reconcile: reconcileBranchPolicies,
  },
  deployment_protection_rules: {
    defaultPolicy: PROTECTION_RULES_DEFAULT_POLICY,
    missingNote: (envName) =>
      `environments[${envName}].deployment_protection_rules: not verifiable while the environment is missing; apply will create the environment and reconcile the declared protection rules`,
    validate: validateProtectionRules,
    reconcile: reconcileProtectionRules,
  },
};

/**
 * Unwrap one nested key's declared value against its own table default.
 * Generic over K so the table lookup and the declared value stay correlated
 * to the same literal key; the union-typed loop variable in run() cannot
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
    NESTED_RECONCILERS[key].defaultPolicy,
  );
}

/** Run one nested key's upfront validation (see NestedReconciler.validate). */
export function validateNested<K extends NestedKey>(key: K, env: EnvironmentConfig): void {
  const declared = env[key];
  if (declared !== undefined) {
    NESTED_RECONCILERS[key].validate?.(env, unwrapNested(key, declared).entries);
  }
}

/** Reconcile one nested key of one environment; generic like validateNested. */
export async function reconcileNested<K extends NestedKey>(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  key: K,
  envName: string,
  nested: Pick<EnvironmentConfig, NestedKey>,
  run: SectionRun,
  liveEnv: Record<string, unknown> | undefined,
): Promise<void> {
  const declared = nested[key];
  if (declared !== undefined) {
    const { policy, entries } = unwrapNested(key, declared);
    await NESTED_RECONCILERS[key].reconcile(ctx, section, envName, policy, entries, run, liveEnv);
  }
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
 * ONE variables-engine scope per environment, the sibling of
 * environmentSecretsScope below: the four operation closures close over this
 * environment's name, so the per-route params contract typechecks here where
 * the literal routes are known, and the engine never sees a route. The label
 * and the suffixes carry the environment name, so every drift, note, and
 * change line is unambiguous when several environments declare variables.
 */
function environmentVariablesScope(envName: string): VariablesScope {
  const ops: VariablesScopeOps = {
    list: async (ctx, section) =>
      parseLive(
        section,
        ENDPOINTS.listVariables,
        z.array(LiveVariable),
        await listAllEnveloped(ctx, section, ENDPOINTS.listVariables, "variables", {
          params: { environment_name: envName },
        }),
        `environment "${envName}"`,
      ),
    create: (ctx, section, name, payload) =>
      call(ctx, section, ENDPOINTS.createVariable, {
        params: { environment_name: envName },
        payload,
        describe: `creating variable "${name}" in environment "${envName}"`,
      }),
    update: (ctx, section, names, payload) =>
      call(ctx, section, ENDPOINTS.updateVariable, {
        params: { environment_name: envName, name: names.live },
        payload,
        describe: `updating variable "${names.declared}" in environment "${envName}"`,
      }),
    remove: (ctx, section, liveName) =>
      call(ctx, section, ENDPOINTS.removeVariable, {
        params: { environment_name: envName, name: liveName },
        describe: `deleting undeclared variable "${liveName}" from environment "${envName}"`,
      }),
  };
  return {
    label: `environments[${envName}].variables`,
    noun: "variable",
    home: "the environment",
    keepHome: `environment "${envName}"`,
    changeSuffix: ` in environment "${envName}"`,
    removeSuffix: ` from environment "${envName}"`,
    ops,
  };
}

/**
 * Reconcile one environment's declared `variables` list through the shared
 * variables engine, under the policy the caller unwrapped against the table
 * default: create missing ones, update divergent values, and apply the
 * undeclared policy to the rest.
 */
async function reconcileVariables(
  _ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly EnvironmentVariableConfig[],
  run: SectionRun,
): Promise<void> {
  // The engine accumulates directly onto run.result, so no merge exists to
  // mispair; the context travels inside `run`, correlated with the result.
  await reconcileEngineVariables(run, section, environmentVariablesScope(envName), {
    entries,
    policy,
    defaultPolicy: NESTED_RECONCILERS.variables.defaultPolicy,
  });
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
 * ONE secrets-engine scope per environment: the four operation closures
 * close over this environment's name, so the per-route params contract
 * typechecks here where the literal routes are known, and the engine never
 * sees a route. The label and noun both carry the environment name, so
 * every drift, note, and change line is unambiguous when several
 * environments declare secrets.
 */
function environmentSecretsScope(envName: string): SecretsScope {
  const ops: SecretsScopeOps = {
    list: async (ctx, section) =>
      parseLive(
        section,
        ENDPOINTS.listSecrets,
        LIVE_SECRET_NAMES,
        await listAllEnveloped(ctx, section, ENDPOINTS.listSecrets, "secrets", {
          params: { environment_name: envName },
        }),
        `environment "${envName}"`,
      ),
    publicKey: (ctx, section, describe) =>
      call(ctx, section, ENDPOINTS.secretsPublicKey, {
        params: { environment_name: envName },
        describe,
      }),
    put: (ctx, section, secretName, payload, describe) =>
      call(ctx, section, ENDPOINTS.putSecret, {
        params: { environment_name: envName, secret_name: secretName },
        payload,
        describe,
      }),
    remove: (ctx, section, secretName, describe) =>
      call(ctx, section, ENDPOINTS.removeSecret, {
        params: { environment_name: envName, secret_name: secretName },
        describe,
      }),
  };
  return {
    label: `environments[${envName}].secrets`,
    noun: `${envName} environment secret`,
    home: "the environment",
    changeSuffix: ` in environment "${envName}"`,
    ops,
  };
}

/**
 * Reconcile one environment's declared `secrets` list through the shared
 * secrets engine, under the policy the caller unwrapped against the table
 * default. Each call is inherently scoped to ITS environment's entries, so
 * same-named secrets across environments can never collide: the engine
 * resolves each entry's own reference through ctx.resolveSecret.
 */
async function reconcileEnvironmentSecrets(
  _ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly EnvironmentSecretConfig[],
  run: SectionRun,
): Promise<void> {
  // The engine accumulates directly onto run.result, so no merge exists to
  // mispair; the context travels inside `run`, correlated with the result.
  await reconcileSecrets(run, section, environmentSecretsScope(envName), {
    entries,
    policy,
    defaultPolicy: NESTED_RECONCILERS.secrets.defaultPolicy,
  });
}
