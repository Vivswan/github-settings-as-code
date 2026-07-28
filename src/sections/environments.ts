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
 * opts into deletion).
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../engine/diff.js";
import type {
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
} as const satisfies Record<string, EndpointDecl>;

/**
 * The per-environment keys that are NOT part of the environment PUT body:
 * each is a sub-resource with its own endpoint family, reconciled AFTER the
 * PUT succeeds by its NESTED_RECONCILERS entry. splitEntry strips them in
 * one place, so a nested key can never leak into the passthrough PUT
 * payload or the check-mode environment diff.
 */
const NESTED_KEYS = [
  "variables",
  "secrets",
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
 * strictly. Today's two entry types are structurally identical, so a
 * swapped pairing is pinned by the unit tests either way; the strict
 * checking is for future keys whose types genuinely differ.
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
};

/**
 * Unwrap one nested key's declared value against its own table default.
 * Generic over K so the table lookup and the declared value stay correlated
 * to the same literal key; the union-typed loop variable in run() cannot
 * express that without casts. The one cast restates NestedDeclared[K] in the
 * spelling undeclaredPolicy infers its entry type from.
 */
function unwrapNested<K extends NestedKey>(
  key: K,
  declared: NestedDeclared[K],
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
): Promise<void> {
  const declared = nested[key];
  if (declared !== undefined) {
    const { policy, entries } = unwrapNested(key, declared);
    await NESTED_RECONCILERS[key].reconcile(ctx, section, envName, policy, entries, result);
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
  grant: grantFor(permission),
  endpoints: ENDPOINTS,
  shape: z.array(
    z.looseObject({
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
          for (const key of NESTED_KEYS) {
            await reconcileNested(ctx, this, key, name, nested, result);
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
          await reconcileNested(ctx, this, key, name, nested, result);
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
