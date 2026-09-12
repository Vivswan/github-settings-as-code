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
 * Stripped from the environment PUT body by splitEntry; each plans as its own sub-resource after
 * the PUT, so none can leak into the PUT payload or the environment diff.
 */
export const NESTED_KEYS = [
  "variables",
  "secrets",
  "deployment_branch_policies",
  "deployment_protection_rules",
] as const satisfies readonly (keyof EnvironmentConfig)[];
export type NestedKey = (typeof NESTED_KEYS)[number];

type NestedDeclared = { [K in NestedKey]: NonNullable<EnvironmentConfig[K]> };

type NestedEntry<K extends NestedKey> = EntryOf<NestedDeclared[K]>;

/**
 * Every nested sub-resource list takes the wrapped `{_undeclared, entries}` form, and the two
 * lockstep types below pin NESTED_KEYS to exactly those keys. A nested list declared as a bare
 * array would evade both checks and ride into the PUT body unnoticed, so give a new key the wrapper.
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

export interface NestedPlan {
  ops: EnvironmentRestOp[];
  notes: string[];
}

/**
 * Function-valued properties, not method shorthand: method parameters check bivariantly,
 * properties strictly, so a planner paired with the wrong key's entry type is a compile error.
 */
interface NestedPlanner<K extends NestedKey> {
  /**
   * The policy for live sub-resources the declared list omits. The section-level "untouched"
   * default describes sibling environments, not the resources inside one, so each key states its own.
   */
  defaultPolicy: UndeclaredPolicy;
  /**
   * Beside a declared environment that does not exist yet: its sub-resources cannot be listed,
   * so every entry plans as a create against an empty environment.
   */
  missingNote: (envName: string) => string;
  /** Rejects misdeclared entries for every environment before anything is read or written. */
  validate?: (env: EnvironmentConfig, entries: readonly NestedEntry<K>[]) => void;
  plan: (
    ctx: EnvironmentsRestContext,
    section: SectionMeta,
    envName: string,
    policy: UndeclaredPolicy,
    entries: readonly NestedEntry<K>[],
    /**
     * undefined for an environment the plan creates: its sub-resources 404 until the PUT lands,
     * so the planner reads nothing and plans every entry as a create.
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
 * Generic over K so the table default and the declared value stay correlated to one literal key.
 * The parameter is spelled NonNullable<EnvironmentConfig[K]>, not the identical NestedDeclared[K]:
 * tsc relates the guarded env[key] to the former directly, while the mapped-type spelling falls
 * back to an intersection over every key that the differing entry types cannot satisfy.
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

/** The undeclared-entry policy one nested key's list carries when the declaration spells none. */
export function nestedDefaultPolicy(key: NestedKey): UndeclaredPolicy {
  return NESTED_PLANNERS[key].defaultPolicy;
}

export function validateNested<K extends NestedKey>(key: K, env: EnvironmentConfig): void {
  const declared = env[key];
  if (declared !== undefined) {
    NESTED_PLANNERS[key].validate?.(env, unwrapNested(key, declared).entries);
  }
}

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
 * Scalars the environment PUT does not accept: splitEntry strips them beside NESTED_KEYS, and each
 * applies through its own routed operation after every PUT (pinned rides the GraphQL pin mutations).
 * The lockstep types pin this list to EnvironmentRoutedScalars, where schema.ts declares routed-ness;
 * a routed scalar declared on EnvironmentConfig itself would ride the PUT body unnoticed.
 */
const ROUTED_SCALAR_KEYS = [
  "pinned",
] as const satisfies readonly (keyof EnvironmentRoutedScalars)[];
type RoutedScalarKey = (typeof ROUTED_SCALAR_KEYS)[number];
type _RoutedScalarsComplete = MustBeNever<Exclude<keyof EnvironmentRoutedScalars, RoutedScalarKey>>;
type _RoutedScalarsSound = MustBeNever<Exclude<RoutedScalarKey, keyof EnvironmentRoutedScalars>>;

// A key in both strip lists would be claimed by whichever loop ran first and never reach the other's handling.
type _StripListsDisjoint = MustBeNever<Extract<NestedKey, RoutedScalarKey>>;

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

/** Two spellings of one case-insensitive name would fight each other on every run. */
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

/** One environment's live Actions variables. */
export async function listEnvironmentVariables(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
): Promise<LiveVariable[]> {
  return parseLive(
    section,
    ENDPOINTS.listVariables,
    z.array(LiveVariable),
    await ctx.read.listVariables.listAllEnveloped("variables", {
      params: { environment_name: envName },
    }),
    `environment "${envName}"`,
  );
}

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
  const live = liveEnv === undefined ? [] : await listEnvironmentVariables(ctx, section, envName);
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
    // GitHub stores the name uppercased whatever casing the file uses, so the name never drifts;
    // only the value and the declared passthrough fields can.
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

/** Two spellings of one case-insensitive name (GitHub stores secret names uppercase) would fight each other on every run. */
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

/** One environment's live Actions secret names (GitHub never lists values). */
export async function listEnvironmentSecrets(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
): Promise<z.infer<typeof LIVE_SECRET_NAMES>> {
  return parseLive(
    section,
    ENDPOINTS.listSecrets,
    LIVE_SECRET_NAMES,
    await ctx.read.listSecrets.listAllEnveloped("secrets", {
      params: { environment_name: envName },
    }),
    `environment "${envName}"`,
  );
}

/**
 * Existence is the only comparable state (values never read back), so every declared secret is a
 * sealed PUT. The sealing key is read inside the first payload thunk: in apply the environment PUT
 * may only just have created the environment the key belongs to.
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
  const live = liveEnv === undefined ? [] : await listEnvironmentSecrets(ctx, section, envName);
  // Real GitHub lists names uppercase already; keying by secretKey keeps a differently-cased mock or proxy harmless.
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
      // The listing decides the verb: the PUT's own 201/204 would say the same, but the executor
      // deliberately does not surface statuses.
      change: `${exists ? "updated" : "created"} secret "${name}"${suffix}`,
      describe: `writing secret "${name}"${suffix}`,
    });
  }
  if (entries.length > 0 && liveEnv !== undefined) {
    // One note per environment; an environment the plan creates already carries the
    // missing-environment note, which covers its whole list.
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
