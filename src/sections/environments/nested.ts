import { z } from "zod";
import type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import { type EntryOf, type SectionMeta, undeclaredPolicy } from "../contract/module.js";
import { LiveSecretName, planSecrets, type SecretsPlanScope } from "../shared/secrets-engine.js";
import {
  LiveVariable,
  planVariables,
  type VariablesPlanScope,
} from "../shared/variables-engine.js";
import { BRANCH_POLICIES_DEFAULT_POLICY, planBranchPolicies } from "./branch-policies.js";
import { ENDPOINTS, type EnvironmentRestOp, type EnvironmentsRestContext } from "./endpoints.js";
import type { LiveEnvironmentBody } from "./index.js";
import { PROTECTION_RULES_DEFAULT_POLICY, planProtectionRules } from "./protection-rules.js";
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
 * Each planner guards its own declared list against duplicates before its first read.
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
    liveEnv: LiveEnvironmentBody | undefined,
  ) => Promise<NestedPlan>;
}

const NESTED_PLANNERS: { [K in NestedKey]: NestedPlanner<K> } = {
  variables: {
    // "delete" like the top-level actions_variables default: variables are
    // readable, recreatable configuration.
    defaultPolicy: "delete",
    missingNote: (envName) =>
      `environments[${envName}].variables: not verifiable while the environment is missing; apply will create the environment and reconcile the declared variables`,
    plan: planEnvironmentVariables,
  },
  secrets: {
    // "keep" like the top-level secret families: a deleted secret's value is
    // unrecoverable, so deletion is opt-in via the wrapped form.
    defaultPolicy: "keep",
    missingNote: (envName) =>
      `environments[${envName}].secrets: not verifiable while the environment is missing; apply will create the environment and reconcile the declared secrets`,
    plan: planEnvironmentSecrets,
  },
  deployment_branch_policies: {
    defaultPolicy: BRANCH_POLICIES_DEFAULT_POLICY,
    missingNote: (envName) =>
      `environments[${envName}].deployment_branch_policies: not verifiable while the environment is missing; apply will create the environment and reconcile the declared patterns`,
    plan: planBranchPolicies,
  },
  deployment_protection_rules: {
    defaultPolicy: PROTECTION_RULES_DEFAULT_POLICY,
    missingNote: (envName) =>
      `environments[${envName}].deployment_protection_rules: not verifiable while the environment is missing; apply will create the environment and reconcile the declared protection rules`,
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

export async function planNested<K extends NestedKey>(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  key: K,
  envName: string,
  nested: Pick<EnvironmentConfig, NestedKey>,
  liveEnv: LiveEnvironmentBody | undefined,
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

/** One environment's live Actions variables. */
export async function listEnvironmentVariables(
  ctx: EnvironmentsRestContext,
  envName: string,
): Promise<LiveVariable[]> {
  return ctx.read.listVariables.listAllEnveloped("variables", LiveVariable, {
    params: { environment_name: envName },
    describe: `environment "${envName}"`,
  });
}

/**
 * The words the two engines render one environment's nested lists with. A variable's kept note names
 * the environment (two environments holding the same undeclared name would otherwise emit one note
 * twice); a secret's noun already carries it. `what` names a duplicate declared pair's resource.
 */
function nestedProse(envName: string, key: "variables" | "secrets", noun: string) {
  return {
    label: `environments[${envName}].${key}`,
    noun,
    where: key === "variables" ? `environment "${envName}"` : "the environment",
    suffix: ` in environment "${envName}"`,
    what: `${key === "variables" ? "variable" : "secret"} of the "${envName}" environment`,
  };
}

type Op<R extends EnvironmentRestOp["role"]> = Extract<EnvironmentRestOp, { role: R }>;

/** The variables engine over one environment; an environment the plan creates lists nothing and plans every entry as a create. */
async function planEnvironmentVariables(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly EnvironmentVariableConfig[],
  liveEnv: LiveEnvironmentBody | undefined,
): Promise<NestedPlan> {
  const params = { environment_name: envName };
  const scope: VariablesPlanScope<
    Op<"createVariable">,
    Op<"updateVariable">,
    Op<"removeVariable">
  > = {
    ...nestedProse(envName, "variables", "variable"),
    list: async () => (liveEnv === undefined ? [] : await listEnvironmentVariables(ctx, envName)),
    create: (write) => ({
      role: "createVariable",
      params,
      payload: write.payload,
      drift: write.drift,
      change: write.change,
      describe: write.describe,
    }),
    update: (write) => ({
      role: "updateVariable",
      params: { ...params, name: write.liveName },
      payload: write.payload,
      drift: write.drift,
      change: write.change,
      describe: write.describe,
    }),
    remove: (deletion) => ({
      role: "removeVariable",
      params: { ...params, name: deletion.name },
      drift: deletion.drift,
      change: deletion.change,
      describe: deletion.describe,
    }),
  };
  const planned = await planVariables(section, scope, {
    entries,
    policy,
    defaultPolicy: NESTED_PLANNERS.variables.defaultPolicy,
  });
  return { ops: planned.ops, notes: planned.notes };
}

/** One environment's live Actions secret names (GitHub never lists values). */
export async function listEnvironmentSecrets(
  ctx: EnvironmentsRestContext,
  envName: string,
): Promise<LiveSecretName[]> {
  return ctx.read.listSecrets.listAllEnveloped("secrets", LiveSecretName, {
    params: { environment_name: envName },
    describe: `environment "${envName}"`,
  });
}

/**
 * The secrets engine over one environment. The sealing key is an execution-phase read (endpoints.ts):
 * in apply the environment PUT may only just have created the environment the key belongs to, so the
 * engine reads it from the first payload thunk that runs, with the token that thunk received.
 */
async function planEnvironmentSecrets(
  ctx: EnvironmentsRestContext,
  section: SectionMeta,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly EnvironmentSecretConfig[],
  liveEnv: LiveEnvironmentBody | undefined,
): Promise<NestedPlan> {
  const params = { environment_name: envName };
  const scope: SecretsPlanScope<Op<"putSecret">, Op<"removeSecret">> = {
    ...nestedProse(envName, "secrets", `${envName} environment secret`),
    list: async () => (liveEnv === undefined ? [] : await listEnvironmentSecrets(ctx, envName)),
    publicKey: (exec, describe) =>
      ctx.read.secretsPublicKey.call(exec, z.unknown(), { params, describe }),
    publicKeyEndpoint: ENDPOINTS.secretsPublicKey,
    put: (write) => ({
      role: "putSecret",
      params: { ...params, secret_name: write.name },
      payload: write.payload,
      drift: write.drift,
      change: write.change,
      describe: write.describe,
    }),
    remove: (deletion) => ({
      role: "removeSecret",
      params: { ...params, secret_name: deletion.name },
      drift: deletion.drift,
      change: deletion.change,
      describe: deletion.describe,
    }),
  };
  const planned = await planSecrets(section, scope, {
    entries,
    policy,
    defaultPolicy: NESTED_PLANNERS.secrets.defaultPolicy,
  });
  return { ops: planned.ops, notes: planned.notes };
}
