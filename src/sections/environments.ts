/**
 * `environments:` section - upsert deployment environments by name via PUT.
 * Undeclared environments are left untouched. A declared nested `variables`
 * key reconciles that environment's Actions variables through their own
 * endpoints (undeclared variables WITHIN a declared key are deleted by
 * default; the wrapped `{undeclared: keep, entries}` form softens that to
 * notes). A declared nested `secrets` key reconciles that environment's
 * Actions secrets through the shared secrets engine, one scope per
 * environment (undeclared secrets WITHIN a declared key are KEPT by default
 * - their values are unrecoverable - and `{undeclared: delete, entries}`
 * opts into deletion). A declared nested `deployment_branch_policies` key
 * reconciles that environment's custom branch-policy patterns (it requires
 * the singular `deployment_branch_policy` sibling to set
 * `custom_branch_policies: true`; a pattern's type is immutable upstream, so
 * a type change is delete plus recreate, and undeclared patterns WITHIN a
 * declared key are deleted by default). A declared nested
 * `deployment_protection_rules` key reconciles that environment's custom
 * deployment protection rules - GitHub App gates, enable/disable only,
 * declared by App slug and resolved to the integration id at apply time
 * (undeclared rules WITHIN a declared key are KEPT by default; disabling a
 * deployment gate is security-relevant, so `{undeclared: delete, entries}`
 * opts in).
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../engine/diff.js";
import type {
  DeploymentBranchPolicyConfig,
  DeploymentProtectionRuleConfig,
  EnvironmentConfig,
  EnvironmentSecretConfig,
  EnvironmentVariableConfig,
  MustBeNever,
  UndeclaredPolicy,
  UndeclaredPolicyList,
} from "../schema.js";
import {
  call,
  type EndpointDecl,
  type EntryOf,
  emptyResult,
  grantFor,
  listAllEnveloped,
  probeAbsent,
  rejectDuplicates,
  type SectionContext,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
  undeclaredPolicyShape,
} from "./contract.js";
import {
  listSecretValues,
  prepareSecretValues,
  reconcileSecrets,
  type SecretsScope,
  type SecretsScopeOps,
  secretKey,
} from "./secrets-engine.js";

const permission: SectionPermission = { repo: ["environments"] };

/**
 * The grant caveat for the branch-policy pattern and protection-rule
 * endpoints, which GitHub gates OUTSIDE the Environments permission
 * (verified against the fine-grained permissions reference): the pattern
 * list and the protection-rule list need Actions read, while the available
 * protection-rule Apps read and the writes of both families need
 * Administration. Appended to the section grant so a denial anywhere in the
 * section names the extra grants.
 */
const NESTED_OVERRIDES_CAVEAT =
  'declared "deployment_branch_policies" and "deployment_protection_rules" keys additionally need "Actions" (read) and "Administration" (read and write)';

/**
 * The 404 on the pattern endpoints is ambiguous: besides a missing grant it
 * can mean the environment does not exist, or that its
 * deployment_branch_policy does not enable custom_branch_policies.
 */
const BRANCH_POLICIES_DENIAL_HINT =
  "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";

/**
 * The 404 on the protection-rule endpoints is ambiguous the same way:
 * besides a missing grant it can mean the environment does not exist.
 */
const PROTECTION_RULES_DENIAL_HINT = "a 404 here can also mean the environment does not exist";

const ENDPOINTS = {
  probe: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}",
    statuses: { 200: "the environment", 404: "no such environment yet" },
  },
  update: {
    route: "PUT /repos/{owner}/{repo}/environments/{environment_name}",
    statuses: { 200: "environment created or updated" },
    hints: {
      422: 'Usually "reviewers" entries are not {type: User|Team, id: <numeric id>} (logins and slugs are not accepted), or "deployment_branch_policy" does not declare both boolean keys (or null to clear it)',
    },
  },
  listVariables: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/variables",
    statuses: { 200: "the environment variable list" },
    // Same documented cap as the repository variables list: GitHub clamps
    // a larger per_page, and a clamped page would read as the last one.
    pageSize: 30,
  },
  createVariable: {
    route: "POST /repos/{owner}/{repo}/environments/{environment_name}/variables",
    statuses: { 201: "environment variable created" },
  },
  updateVariable: {
    route: "PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}",
    statuses: { 204: "environment variable updated" },
  },
  removeVariable: {
    route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}",
    statuses: { 204: "environment variable deleted" },
  },
  listSecrets: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets",
    statuses: { 200: "the environment secrets list (names and timestamps; never values)" },
  },
  secretsPublicKey: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key",
    statuses: { 200: "the environment sealing public key" },
  },
  putSecret: {
    route: "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
    statuses: { 201: "environment secret created", 204: "environment secret updated" },
    alwaysRewrite: true,
  },
  removeSecret: {
    route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
    statuses: { 204: "environment secret deleted" },
  },
  listPolicies: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
    statuses: { 200: "the deployment branch-policy pattern list" },
    // GitHub gates this read under Actions, not Environments (the OIDC
    // customization pair in actions.ts is the precedent for the override).
    permission: { repo: ["actions"] },
    denialHint: BRANCH_POLICIES_DENIAL_HINT,
  },
  createPolicy: {
    route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
    // GitHub documents 200 for the create (never 201), and 303 when a policy
    // with the same name pattern already exists - desired state is there
    // either way, so the handler treats 303 as converged.
    statuses: {
      200: "deployment branch policy created",
      303: "a policy with this name pattern already exists",
    },
    permission: { repo: ["administration"] },
    denialHint: BRANCH_POLICIES_DENIAL_HINT,
    hints: {
      422: 'Usually the pattern\'s "type" is not one of the values GitHub accepts ("branch" or "tag"); see the deployment branch policies endpoint documentation',
    },
  },
  removePolicy: {
    route:
      "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}",
    statuses: { 204: "deployment branch policy deleted" },
    permission: { repo: ["administration"] },
    denialHint: BRANCH_POLICIES_DENIAL_HINT,
  },
  // The protection-rule endpoints spell their path segment with UNDERSCORES
  // (deployment_protection_rules), unlike the hyphenated branch-policy
  // family. GitHub gates them outside the Environments permission too:
  // the enabled-rules list under Actions, everything else under
  // Administration (fine-grained permissions reference).
  listProtectionRules: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules",
    statuses: { 200: "the enabled custom deployment protection rules" },
    permission: { repo: ["actions"] },
    denialHint: PROTECTION_RULES_DENIAL_HINT,
  },
  listProtectionRuleApps: {
    route:
      "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps",
    statuses: { 200: "the protection-rule Apps available to this environment" },
    permission: { repo: ["administration"] },
    denialHint: PROTECTION_RULES_DENIAL_HINT,
  },
  createProtectionRule: {
    route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules",
    statuses: { 201: "custom deployment protection rule enabled" },
    permission: { repo: ["administration"] },
    denialHint: PROTECTION_RULES_DENIAL_HINT,
  },
  removeProtectionRule: {
    route:
      "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}",
    statuses: { 204: "custom deployment protection rule disabled" },
    permission: { repo: ["administration"] },
    denialHint: PROTECTION_RULES_DENIAL_HINT,
  },
} as const satisfies Record<string, EndpointDecl>;

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
   * literal per key on purpose: the section-level default ("untouched")
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
    result: SectionResult,
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

const NESTED_RECONCILERS: { [K in NestedKey]: NestedReconciler<K> } = {
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
    // "delete" like the nested variables list: patterns are readable,
    // recreatable configuration.
    defaultPolicy: "delete",
    missingNote: (envName) =>
      `environments[${envName}].deployment_branch_policies: not verifiable while the environment is missing; apply will create the environment and reconcile the declared patterns`,
    validate: validateBranchPolicies,
    reconcile: reconcileBranchPolicies,
  },
  deployment_protection_rules: {
    // "keep" like the secret families, for a security reason instead of an
    // unrecoverable one: Apps can enable themselves as deployment gates, and
    // silently disabling a gate the file never named would weaken a
    // protection nobody asked to weaken. Disabling is opt-in via the wrapped
    // form.
    defaultPolicy: "keep",
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
function validateNested<K extends NestedKey>(key: K, env: EnvironmentConfig): void {
  const declared = env[key];
  if (declared !== undefined) {
    NESTED_RECONCILERS[key].validate?.(env, unwrapNested(key, declared).entries);
  }
}

/** Reconcile one nested key of one environment; generic like validateNested. */
async function reconcileNested<K extends NestedKey>(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  key: K,
  envName: string,
  nested: Pick<EnvironmentConfig, NestedKey>,
  result: SectionResult,
  liveEnv: Record<string, unknown> | undefined,
): Promise<void> {
  const declared = nested[key];
  if (declared !== undefined) {
    const { policy, entries } = unwrapNested(key, declared);
    await NESTED_RECONCILERS[key].reconcile(
      ctx,
      section,
      envName,
      policy,
      entries,
      result,
      liveEnv,
    );
  }
}

/** Split one declared entry into the PUT/diff payload and the nested sub-resources. */
function splitEntry(env: EnvironmentConfig): {
  settings: Record<string, unknown>;
  nested: Pick<EnvironmentConfig, NestedKey>;
} {
  const { name: _name, ...settings } = env;
  const nested: Pick<EnvironmentConfig, NestedKey> = {};
  for (const key of NESTED_KEYS) {
    if (key in settings) {
      (nested as Record<string, unknown>)[key] = settings[key];
      delete settings[key];
    }
  }
  return { settings: settings as Record<string, unknown>, nested };
}

export const environmentsSection: SectionModule<"environments"> = {
  key: "environments",
  undeclaredDefault: "untouched",
  permission,
  grant: grantFor(permission, NESTED_OVERRIDES_CAVEAT),
  endpoints: ENDPOINTS,
  shape: z.array(
    z
      .looseObject({
        name: z.string(),
        // Loose like the repository actions_variables entries: the POST/PATCH
        // bodies pass extra fields through verbatim, so a field GitHub ships
        // tomorrow can be declared here the day it appears.
        variables: undeclaredPolicyShape(
          z.array(z.looseObject({ name: z.string(), value: z.string() })),
        ).optional(),
        // STRICT entries, unlike variables: a secret's PUT body is built from
        // the sealed value alone, so an extra entry key has no destination and
        // would silently do nothing (the actions_secrets closedSurface rule;
        // closedSurface itself cannot reach a nested list, so the shape
        // enforces it here).
        secrets: undeclaredPolicyShape(
          z.array(z.strictObject({ name: z.string(), value: z.string() })),
        ).optional(),
        // Loose like the variables entries: the create POST passes extra
        // fields through verbatim. `type` is checked as a plain string (the
        // handler compares it against the live pattern); GitHub stays the
        // authority on its values, and the published schema documents the
        // upstream enum.
        deployment_branch_policies: undeclaredPolicyShape(
          z.array(z.looseObject({ name: z.string(), type: z.string().optional() })),
        ).optional(),
        // STRICT entries, like secrets: the enable POST is built solely from
        // the App's resolved integration_id, so an extra entry key has no
        // destination and would silently do nothing.
        deployment_protection_rules: undeclaredPolicyShape(
          z.array(z.strictObject({ app: z.string() })),
        ).optional(),
        // Secrets live under the plural `secrets` list; a singular entry-level
        // `secret` would pass the loose shape into the environment PUT body
        // verbatim and configure nothing, so the misplacement is rejected by
        // name (the webhooks entry-level `secret` pin precedent).
        secret: z
          .undefined({
            error:
              "environment secrets belong under the entry's `secrets` list, not a singular `secret` key; here it would pass through to the environment PUT verbatim and configure nothing",
          })
          .optional(),
      })
      .superRefine((entry, refineCtx) => {
        // The flag-pairing invariant lives HERE, in the shape, not in the
        // section's validate hook: upfront document validation rejects the
        // document in BOTH modes before ANY section writes. A hook-level check
        // would fire only when this section runs (the apply-mode preflight
        // ignores non-permission errors), after earlier sections already
        // wrote - and the pattern POST itself would 404 only after the
        // environment PUT landed, half-applying the run.
        if (entry.deployment_branch_policies === undefined) {
          return;
        }
        const flags = (entry as Record<string, unknown>).deployment_branch_policy as
          | { custom_branch_policies?: unknown }
          | null
          | undefined;
        if (flags?.custom_branch_policies !== true) {
          refineCtx.addIssue({
            code: "custom",
            path: ["deployment_branch_policies"],
            message: `the "${entry.name}" entry declares deployment_branch_policies, so it must also declare deployment_branch_policy with custom_branch_policies: true - GitHub rejects every pattern write while the flag is off`,
          });
        }
      }),
  ),
  /**
   * The declared value of every entry's secrets list, across all declared
   * environments, for the engine's up-front reference resolution. DEFENSIVE
   * like the shared extractor: a malformed container contributes nothing
   * instead of throwing, so the actionable error always comes from shape
   * validation.
   */
  secretValues(declared: unknown): string[] {
    if (!Array.isArray(declared)) {
      return [];
    }
    return declared.flatMap((entry) =>
      typeof entry === "object" && entry !== null
        ? listSecretValues((entry as EnvironmentConfig).secrets)
        : [],
    );
  },
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as EnvironmentConfig[];
    rejectDuplicates(
      this,
      desired,
      (env) => env.name.toLowerCase(),
      (env) => env.name,
    );
    // Validate every nested list upfront, BEFORE any write: a duplicate
    // discovered mid-loop would leave earlier environments applied and later
    // ones untouched.
    for (const env of desired) {
      for (const key of NESTED_KEYS) {
        validateNested(key, env);
      }
    }
    for (const env of desired) {
      const { settings, nested } = splitEntry(env);
      const name = env.name;
      if (ctx.check) {
        const probe = await probeAbsent(ctx, this, ENDPOINTS.probe, {
          params: { environment_name: name },
        });
        if ("missing" in probe) {
          result.drift.push(
            `environments[${name}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
          for (const key of NESTED_KEYS) {
            if (nested[key] !== undefined) {
              result.notes.push(NESTED_RECONCILERS[key].missingNote(name));
            }
          }
        } else {
          result.drift.push(
            ...subsetDiff(settings, flattenEnvironment(probe.data), `environments[${name}]`),
          );
          const liveEnv = (probe.data ?? {}) as Record<string, unknown>;
          for (const key of NESTED_KEYS) {
            await reconcileNested(ctx, this, key, name, nested, result, liveEnv);
          }
        }
      } else {
        await call(ctx, this, ENDPOINTS.update, {
          params: { environment_name: name },
          payload: settings,
          describe: `upserting environment "${name}"`,
        });
        result.changes.push(`applied environment "${name}"`);
        for (const key of NESTED_KEYS) {
          await reconcileNested(ctx, this, key, name, nested, result, undefined);
        }
      }
    }
    return result;
  },
};

/** The fields of a live variable this section reads. */
interface LiveVariable {
  name: string;
  value: string;
}

/** GitHub matches variable names case-insensitively; uppercase both sides. */
function variableKey(name: string): string {
  return name.toUpperCase();
}

/**
 * Reject two declared variables whose names collapse to the same
 * case-insensitive key: they would fight each other on every run.
 */
function rejectDuplicateVariables(
  envName: string,
  entries: readonly EnvironmentVariableConfig[],
): void {
  const seen = new Map<string, string>();
  for (const variable of entries) {
    const key = variableKey(variable.name);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `environments: the "${envName}" entry declares variables "${first}" and "${variable.name}", which GitHub treats as the same variable (names are case-insensitive). Keep exactly one entry per variable`,
      );
    }
    seen.set(key, variable.name);
  }
}

/**
 * Reconcile one environment's declared `variables` list against the live
 * variables: create missing ones, update divergent values, and apply the
 * undeclared policy (unwrapped by the caller against the table default) to
 * the rest.
 */
async function reconcileVariables(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly EnvironmentVariableConfig[],
  result: SectionResult,
): Promise<void> {
  const declaredKeys = new Set(entries.map((variable) => variableKey(variable.name)));
  const live = (await listAllEnveloped(ctx, section, ENDPOINTS.listVariables, "variables", {
    params: { environment_name: envName },
  })) as LiveVariable[];
  const liveByKey = new Map<string, LiveVariable>();
  for (const variable of live) {
    liveByKey.set(variableKey(variable.name), variable);
  }

  for (const variable of entries) {
    const label = `environments[${envName}].variables[${variable.name}]`;
    const existing = liveByKey.get(variableKey(variable.name));
    const { name: _name, value: _value, ...extraKeys } = variable;
    if (!existing) {
      if (ctx.check) {
        result.drift.push(
          `${label}: missing - declared in the settings file but not on the environment; apply will create it`,
        );
      } else {
        await call(ctx, section, ENDPOINTS.createVariable, {
          params: { environment_name: envName },
          payload: { name: variable.name, value: variable.value, ...extraKeys },
          describe: `creating variable "${variable.name}" in environment "${envName}"`,
        });
        result.changes.push(`created variable "${variable.name}" in environment "${envName}"`);
      }
      continue;
    }
    const valueDrift = existing.value !== variable.value;
    const extraDrift = subsetDiff(extraKeys, existing, label);
    if (!valueDrift && extraDrift.length === 0) {
      continue;
    }
    if (ctx.check) {
      if (valueDrift) {
        result.drift.push(
          `${label}.value: declared ${JSON.stringify(variable.value)} != live ${JSON.stringify(existing.value)}; apply will set the declared value`,
        );
      }
      result.drift.push(...extraDrift);
    } else {
      const phantom = phantomKeys(extraKeys, existing);
      if (phantom.length > 0) {
        result.notes.push(phantomNote(label, phantom, "variable", "this update will re-run"));
      }
      await call(ctx, section, ENDPOINTS.updateVariable, {
        // The live name addresses the PATCH: same variable under GitHub's
        // case-insensitive matching, and the path always names what exists.
        params: { environment_name: envName, name: existing.name },
        payload: { value: variable.value, ...extraKeys },
        describe: `updating variable "${variable.name}" in environment "${envName}"`,
      });
      result.changes.push(`updated variable "${variable.name}" in environment "${envName}"`);
    }
  }

  for (const variable of liveByKey.values()) {
    if (declaredKeys.has(variableKey(variable.name))) {
      continue;
    }
    if (policy === "keep") {
      result.notes.push(
        `variable "${variable.name}" exists on environment "${envName}" but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it`,
      );
    } else if (ctx.check) {
      result.drift.push(
        `environments[${envName}].variables[${variable.name}]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it`,
      );
    } else {
      await call(ctx, section, ENDPOINTS.removeVariable, {
        params: { environment_name: envName, name: variable.name },
        describe: `deleting undeclared variable "${variable.name}" from environment "${envName}"`,
      });
      result.changes.push(
        `DELETED undeclared variable "${variable.name}" from environment "${envName}"`,
      );
    }
  }
}

/**
 * Reject two declared secrets whose names collapse to the same
 * case-insensitive key (GitHub stores secret names uppercase): they would
 * fight each other on every run.
 */
function rejectDuplicateSecrets(
  envName: string,
  entries: readonly EnvironmentSecretConfig[],
): void {
  const seen = new Map<string, string>();
  for (const secret of entries) {
    const key = secretKey(secret.name);
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(
        `environments: the "${envName}" entry declares secrets "${first}" and "${secret.name}", which GitHub treats as the same secret (names are case-insensitive). Keep exactly one entry per secret`,
      );
    }
    seen.set(key, secret.name);
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
    list: (ctx, section) =>
      listAllEnveloped(ctx, section, ENDPOINTS.listSecrets, "secrets", {
        params: { environment_name: envName },
      }),
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
 * default. prepareSecretValues runs PER ENVIRONMENT - per scope - because
 * its lookup is keyed by secret name alone: one global call would silently
 * collide same-named secrets across environments and seal the wrong
 * plaintext.
 */
async function reconcileEnvironmentSecrets(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly EnvironmentSecretConfig[],
  result: SectionResult,
): Promise<void> {
  const resolvedValueOf = prepareSecretValues(ctx, section, entries);
  const scoped = await reconcileSecrets(ctx, section, environmentSecretsScope(envName), {
    entries,
    policy,
    resolvedValueOf,
  });
  result.changes.push(...scoped.changes);
  result.drift.push(...scoped.drift);
  result.notes.push(...scoped.notes);
}

/**
 * The fields of a live branch policy this section reads. GitHub's spec marks
 * every one of them optional, so each is read defensively: a missing type
 * reads as the server-side default "branch", while a missing name or id is a
 * contract break that fails loudly - a policy without a name has no identity
 * to reconcile by, and silently skipping it would let check report falsely
 * clean while the default delete policy neither removed nor noted it.
 */
interface LiveBranchPolicy {
  id?: number;
  name?: string;
  type?: string;
}

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
function validateBranchPolicies(
  env: EnvironmentConfig,
  entries: readonly DeploymentBranchPolicyConfig[],
): void {
  const seen = new Set<string>();
  for (const pattern of entries) {
    if (seen.has(pattern.name)) {
      throw new Error(
        `environments: the "${env.name}" entry declares the deployment branch policy "${pattern.name}" twice. Keep exactly one entry per pattern`,
      );
    }
    seen.add(pattern.name);
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
async function reconcileBranchPolicies(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly DeploymentBranchPolicyConfig[],
  result: SectionResult,
  liveEnv: Record<string, unknown> | undefined,
): Promise<void> {
  if (ctx.check) {
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
      result.notes.push(
        `environments[${envName}].deployment_branch_policies: patterns are not verifiable until custom_branch_policies is true; apply will set the flag and reconcile the declared patterns`,
      );
      return;
    }
  }
  const live = (await listAllEnveloped(ctx, section, ENDPOINTS.listPolicies, "branch_policies", {
    params: { environment_name: envName },
  })) as LiveBranchPolicy[];
  const liveByName = new Map<string, LiveBranchPolicy>();
  for (const pattern of live) {
    liveByName.set(livePolicyName(pattern, envName), pattern);
  }
  const declared = new Set(entries.map((pattern) => pattern.name));

  for (const pattern of entries) {
    const label = `environments[${envName}].deployment_branch_policies[${pattern.name}]`;
    const existing = liveByName.get(pattern.name);
    if (!existing) {
      if (ctx.check) {
        result.drift.push(
          `${label}: missing - declared in the settings file but not on the environment; apply will create it`,
        );
      } else {
        await createBranchPolicy(ctx, section, envName, pattern);
        result.changes.push(
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
    if (ctx.check) {
      result.drift.push(
        `${label}: the declared type differs from the live pattern's, and a policy's type is immutable; apply will delete and recreate it`,
      );
      // Name the differing values; the generic line alone left the reader
      // guessing which side says what.
      result.drift.push(...subsetDiff({ type: desiredType }, { type: liveType }, label));
    } else {
      await call(ctx, section, ENDPOINTS.removePolicy, {
        params: { environment_name: envName, branch_policy_id: livePolicyId(existing, envName) },
        describe: `deleting deployment branch policy "${pattern.name}" in environment "${envName}" to change its immutable type`,
      });
      await createBranchPolicy(ctx, section, envName, pattern);
      result.changes.push(
        `replaced deployment branch policy "${pattern.name}" in environment "${envName}" (type is immutable; ${liveType} -> ${desiredType})`,
      );
    }
  }

  for (const [name, existing] of liveByName) {
    if (declared.has(name)) {
      continue;
    }
    if (policy === "keep") {
      result.notes.push(
        `deployment branch policy "${name}" exists on environment "${envName}" but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it`,
      );
    } else if (ctx.check) {
      result.drift.push(
        `environments[${envName}].deployment_branch_policies[${name}]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it`,
      );
    } else {
      await call(ctx, section, ENDPOINTS.removePolicy, {
        params: { environment_name: envName, branch_policy_id: livePolicyId(existing, envName) },
        describe: `deleting undeclared deployment branch policy "${name}" from environment "${envName}"`,
      });
      result.changes.push(
        `DELETED undeclared deployment branch policy "${name}" from environment "${envName}"`,
      );
    }
  }
}

/**
 * The fields of a live custom deployment protection rule this section reads.
 * The spec marks every field required, but the identity fields are still
 * extracted loudly (the livePolicyName precedent): a rule without an App
 * slug has no identity to reconcile by, and silently skipping it would let
 * check report falsely clean. The endpoint documents that it returns
 * enabled rules only, so presence in the list is the enablement signal;
 * `enabled` is read anyway as a belt over that contract - a rule the API
 * ever reported as disabled must not satisfy a declared gate.
 */
interface LiveProtectionRule {
  id?: number;
  enabled?: boolean;
  app?: { id?: number; slug?: string };
}

/** The App slug a rule reconciles by, or a loud error when the response omitted it. */
function liveRuleSlug(rule: LiveProtectionRule, envName: string): string {
  const slug = rule.app?.slug;
  if (typeof slug !== "string") {
    throw new Error(
      `environments: the deployment protection rule list for environment "${envName}" returned a rule without an app slug, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return slug;
}

/** The id a disable addresses, or a loud error when the response omitted it. */
function liveRuleId(rule: LiveProtectionRule, envName: string): string {
  // Only a real number may address the DELETE: a null or string id would
  // otherwise serialize into the path (".../deployment_protection_rules/null").
  if (typeof rule.id !== "number") {
    throw new Error(
      `environments: the deployment protection rule list for environment "${envName}" returned a rule without a numeric id, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return String(rule.id);
}

/**
 * The enabled rules of one environment. A single call(), NOT
 * listAllEnveloped: this endpoint documents no page/per_page parameters, so
 * the page loop would append a query GitHub never specified. Both envelope
 * keys are optional in the spec, so an ABSENT list reads as empty - but a
 * PRESENT non-array value is a contract break that fails loudly.
 */
async function listProtectionRules(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
): Promise<LiveProtectionRule[]> {
  const data = (await call(ctx, section, ENDPOINTS.listProtectionRules, {
    params: { environment_name: envName },
    describe: `listing deployment protection rules of environment "${envName}"`,
  })) as { custom_deployment_protection_rules?: unknown } | null;
  const rules = data?.custom_deployment_protection_rules;
  if (rules === undefined) {
    return [];
  }
  if (!Array.isArray(rules)) {
    throw new Error(
      `environments: the deployment protection rule list for environment "${envName}" returned a custom_deployment_protection_rules value that is not a list, so it cannot be reconciled. Check the "api-version" input against the GitHub REST docs for this endpoint`,
    );
  }
  return rules as LiveProtectionRule[];
}

/**
 * Resolve each declared App slug to its integration id via the
 * available-Apps listing (fetched by the caller only when a declared rule is
 * missing). A slug the listing does not carry is a hard error naming the
 * available slugs: the App is not installed or does not provide a rule for
 * this environment, and no API call this section may make can change that.
 */
function resolveIntegrationId(
  apps: readonly LiveProtectionRuleApp[],
  slug: string,
  envName: string,
): number {
  const app = apps.find((candidate) => candidate.slug === slug);
  if (app === undefined) {
    const available =
      apps.length > 0
        ? `the available Apps are ${apps.map((candidate) => `"${candidate.slug}"`).join(", ")}`
        : "no protection-rule Apps are available to it";
    throw new Error(
      `environments: the deployment protection rule App "${slug}" is not available to environment "${envName}" (${available}). Install the GitHub App providing the rule on this repository, or declare one of the available slugs`,
    );
  }
  return app.id;
}

/** The fields of an available protection-rule App this section reads. */
interface LiveProtectionRuleApp {
  id: number;
  slug: string;
}

/**
 * The available-Apps listing, with the identity fields extracted loudly
 * (an App without a slug or id could neither be offered in the
 * unknown-slug error nor resolve a declared rule).
 */
async function listProtectionRuleApps(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
): Promise<LiveProtectionRuleApp[]> {
  const apps = (await listAllEnveloped(
    ctx,
    section,
    ENDPOINTS.listProtectionRuleApps,
    "available_custom_deployment_protection_rule_integrations",
    { params: { environment_name: envName } },
  )) as Array<{ id?: unknown; slug?: unknown }>;
  return apps.map((app) => {
    if (typeof app.id !== "number" || typeof app.slug !== "string") {
      throw new Error(
        `environments: the available protection-rule App list for environment "${envName}" returned an App without an id or slug, so declared rules cannot be resolved. Check the "api-version" input against the GitHub REST docs for this endpoint`,
      );
    }
    return { id: app.id, slug: app.slug };
  });
}

/**
 * Upfront rejection of duplicate declared App slugs: the same gate enabled
 * twice would fight itself on every run.
 */
function validateProtectionRules(
  env: EnvironmentConfig,
  entries: readonly DeploymentProtectionRuleConfig[],
): void {
  const seen = new Set<string>();
  for (const rule of entries) {
    if (seen.has(rule.app)) {
      throw new Error(
        `environments: the "${env.name}" entry declares the deployment protection rule App "${rule.app}" twice. Keep exactly one entry per App`,
      );
    }
    seen.add(rule.app);
  }
}

/**
 * Reconcile one environment's declared `deployment_protection_rules` list
 * against the enabled rules. Enable/disable only - GitHub offers no update
 * call - so a missing declared rule is enabled (its slug resolved to the
 * integration id through ONE available-Apps fetch, made only when something
 * is missing) and a live undeclared rule follows the policy the caller
 * unwrapped against the table default ("keep": disabling a deployment gate
 * is opt-in).
 */
async function reconcileProtectionRules(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
  policy: UndeclaredPolicy,
  entries: readonly DeploymentProtectionRuleConfig[],
  result: SectionResult,
): Promise<void> {
  const live = await listProtectionRules(ctx, section, envName);
  const liveBySlug = new Map<string, LiveProtectionRule>();
  for (const rule of live) {
    // The map models gates that are ON (see the LiveProtectionRule JSDoc):
    // skipping a disabled rule makes apply re-enable a declared gate instead
    // of reading falsely clean, and in the undeclared direction a disabled
    // rule is not an active gate, so neither the keep-note nor the disable
    // applies to it.
    if (rule.enabled === false) {
      continue;
    }
    liveBySlug.set(liveRuleSlug(rule, envName), rule);
  }
  const declared = new Set(entries.map((rule) => rule.app));

  const missing = entries.filter((rule) => !liveBySlug.has(rule.app));
  if (ctx.check) {
    for (const rule of missing) {
      result.drift.push(
        `environments[${envName}].deployment_protection_rules[${rule.app}]: missing - declared in the settings file but not enabled on the environment; apply will enable it if the App is available to this environment`,
      );
    }
  } else if (missing.length > 0) {
    const apps = await listProtectionRuleApps(ctx, section, envName);
    // Resolve EVERY missing slug before the first POST: an unknown slug is a
    // hard error, and discovering it mid-loop would leave the environment
    // half-reconciled - the same validate-before-write posture as the
    // section's upfront duplicate checks.
    const resolved = missing.map((rule) => ({
      rule,
      integrationId: resolveIntegrationId(apps, rule.app, envName),
    }));
    for (const { rule, integrationId } of resolved) {
      await call(ctx, section, ENDPOINTS.createProtectionRule, {
        params: { environment_name: envName },
        payload: { integration_id: integrationId },
        describe: `enabling deployment protection rule "${rule.app}" in environment "${envName}"`,
      });
      result.changes.push(
        `enabled deployment protection rule "${rule.app}" in environment "${envName}"`,
      );
    }
  }

  for (const [slug, rule] of liveBySlug) {
    if (declared.has(slug)) {
      continue;
    }
    if (policy === "keep") {
      result.notes.push(
        `deployment protection rule "${slug}" is enabled on environment "${envName}" but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DISABLE it`,
      );
    } else if (ctx.check) {
      result.drift.push(
        `environments[${envName}].deployment_protection_rules[${slug}]: undeclared - not in the settings file, so apply will DISABLE it; add it to the settings file to keep it`,
      );
    } else {
      await call(ctx, section, ENDPOINTS.removeProtectionRule, {
        params: { environment_name: envName, protection_rule_id: liveRuleId(rule, envName) },
        describe: `disabling undeclared deployment protection rule "${slug}" in environment "${envName}"`,
      });
      result.changes.push(
        `DISABLED undeclared deployment protection rule "${slug}" in environment "${envName}"`,
      );
    }
  }
}

/**
 * GET /environments/{name} nests wait_timer / prevent_self_review / reviewers
 * inside protection_rules[]; translate back into the PUT request shape so
 * check mode compares like with like. Exported so the e2e state tests assert
 * their environmentFromPut transformer inverts this exact function (not a
 * lookalike copy).
 */
export function flattenEnvironment(live: unknown): Record<string, unknown> {
  const raw = (live ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  const rules = (raw.protection_rules ?? []) as Array<Record<string, unknown>>;
  for (const rule of rules) {
    if (rule.type === "wait_timer") {
      out.wait_timer = rule.wait_timer;
    } else if (rule.type === "required_reviewers") {
      if (rule.prevent_self_review !== undefined) {
        out.prevent_self_review = rule.prevent_self_review;
      }
      const reviewers = (rule.reviewers ?? []) as Array<{
        type: unknown;
        reviewer?: { id?: unknown };
      }>;
      out.reviewers = reviewers.map((r) => ({ type: r.type, id: r.reviewer?.id }));
    } else {
      // Future rule types: un-nest their payload keys generically so check
      // mode can compare declared settings instead of reporting false drift.
      for (const [key, value] of Object.entries(rule)) {
        if (!["id", "node_id", "type", "url"].includes(key)) {
          out[key] = value;
        }
      }
    }
  }
  return out;
}
