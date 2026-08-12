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
import { subsetDiff } from "../../engine/diff.js";
import type { MustBeNever, UndeclaredPolicy, UndeclaredPolicyList } from "../../types.js";
import { type EndpointDecl, repoVariables } from "../contract/endpoints.js";
import { type GraphqlOpDecl, graphqlOp } from "../contract/graphql.js";
import { parseLive } from "../contract/live.js";
import {
  beginRun,
  type DeclaredSecretValue,
  type EntryOf,
  loosen,
  type SectionContext,
  type SectionModule,
  type SectionResult,
  type SectionRun,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  call,
  callGraphql,
  listAllEnveloped,
  listGraphqlConnection,
  probeAbsent,
  rejectDuplicates,
  tryCallGraphql,
} from "../contract/requests.js";
import {
  LIVE_SECRET_NAMES,
  listSecretValues,
  reconcileSecrets,
  type SecretsScope,
  type SecretsScopeOps,
  secretKey,
} from "../secrets-engine.js";
import {
  LiveVariable,
  reconcileVariables as reconcileEngineVariables,
  type VariablesScope,
  type VariablesScopeOps,
  variableKey,
} from "../shared/variables-engine.js";
import {
  type DeploymentBranchPolicyConfig,
  type DeploymentProtectionRuleConfig,
  type EnvironmentConfig,
  type EnvironmentRoutedScalars,
  type EnvironmentSecretConfig,
  EnvironmentsSlice,
  type EnvironmentVariableConfig,
  MAX_PINNED_ENVIRONMENTS,
} from "./schema.js";

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
 * The pinned-environments listing: each node is a PinnedEnvironment carrying
 * the ORDERING as its own `position` field (1-based; ordering does NOT live
 * on the Environment object) plus the pinned environment's name. Verified
 * against live GitHub: position numbers may be NON-CONTIGUOUS - unpinning
 * leaves a hole, a new pin appends via a monotonic counter, and only a
 * reorder renormalizes - so positions are consumed as a SORT KEY (rank),
 * never as literal slot numbers. NOT_FOUND is a declared outcome so a
 * fine-grained read denial - which GraphQL delivers as NOT_FOUND on the
 * repository - reads as "no pins", the same absent posture as the section's
 * REST probe (DENIAL_SEMANTICS keeps environments "absent"); the denial then
 * surfaces on the first write, exactly like the environment PUT.
 */
const PINS_QUERY = graphqlOp<{ owner: string; repo: string }>()({
  name: "EnvironmentPins",
  kind: "read",
  query:
    "query EnvironmentPins($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { pinnedEnvironments(first: 100, after: $cursor) { nodes { position environment { name } } pageInfo { hasNextPage endCursor } } } }",
  connection: { path: ["repository", "pinnedEnvironments"] },
  outcomes: {
    ok: "the pinned environments with their 1-based positions",
    NOT_FOUND:
      "the repository is not visible to the token; read as no pins (the denial surfaces on the first pin write)",
  },
});

/**
 * Pin or unpin one environment, addressed by the node id the REST PUT/GET
 * environment bodies carry (the new-format EN_ ids; no deprecated-ID
 * warnings). Verified against live GitHub: a new pin lands at the TAIL of
 * the pinned list (a monotonic position counter; unpinning never renumbers),
 * which is what lets the reconciler model appends locally instead of
 * re-reading. UNPROCESSABLE is a declared outcome: it is how GitHub rejects
 * a pin once the repository already holds MAX_PINNED_ENVIRONMENTS pins,
 * which the handler turns into an actionable error naming the cap and the
 * way to make room.
 */
const PIN_ENVIRONMENT = graphqlOp<{ environmentId: string; pinned: boolean }>()({
  name: "PinEnvironment",
  kind: "write",
  query:
    "mutation PinEnvironment($environmentId: ID!, $pinned: Boolean!) { pinEnvironment(input: { environmentId: $environmentId, pinned: $pinned }) { environment { name isPinned } } }",
  outcomes: {
    ok: "the environment was pinned or unpinned",
    UNPROCESSABLE: `the repository already holds ${MAX_PINNED_ENVIRONMENTS} pinned environments (GitHub's cap), so this pin was rejected`,
  },
});

/**
 * Move one pinned environment to a 1-based RANK; verified against live
 * GitHub, this is also the only mutation that renormalizes the position
 * numbers (the whole list reads back contiguous afterwards). The reconciler
 * only ever moves a pin LEFT (toward rank 1), where remove-and-insert
 * semantics are unambiguous.
 */
const REORDER_ENVIRONMENT = graphqlOp<{ environmentId: string; position: number }>()({
  name: "ReorderEnvironment",
  kind: "write",
  query:
    "mutation ReorderEnvironment($environmentId: ID!, $position: Int!) { reorderEnvironment(input: { environmentId: $environmentId, position: $position }) { environment { name } } }",
  outcomes: { ok: "the pinned environment moved to its declared position" },
});

const GRAPHQL_OPS = {
  pins: PINS_QUERY,
  pin: PIN_ENVIRONMENT,
  reorder: REORDER_ENVIRONMENT,
} as const satisfies Record<string, GraphqlOpDecl>;

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
function splitEntry(env: EnvironmentConfig): {
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

export const environmentsSection = {
  key: "environments",
  undeclaredDefault: "untouched",
  permission,
  grantCaveat: NESTED_OVERRIDES_CAVEAT,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL_OPS,
  shape: loosen(EnvironmentsSlice),
  /**
   * The declared value of every entry's secrets list, across all declared
   * environments, for the engine's up-front reference resolution - each
   * label carries the ENVIRONMENT alongside the secret name, since several
   * environments can declare same-named secrets. DEFENSIVE
   * like the shared extractor: a malformed container contributes nothing
   * instead of throwing, so the actionable error always comes from shape
   * validation.
   */
  secretValues(declared: unknown): DeclaredSecretValue[] {
    if (!Array.isArray(declared)) {
      return [];
    }
    return declared.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }
      const env = entry as EnvironmentConfig;
      const where =
        typeof env.name === "string" ? `environment "${env.name}"` : "an unnamed environment";
      return listSecretValues(env.secrets).map(({ label, value }) => ({
        label: `${label} of ${where}`,
        value,
      }));
    });
  },
  async run(ctx, desired): Promise<SectionResult> {
    const run = beginRun(ctx);
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
    // The node id of each declared environment, captured from the PUT body
    // in apply mode for the pin mutations - the bodies carry the new-format
    // EN_ ids, so no extra lookup is ever needed. Check mode never mutates,
    // so it captures none. Keyed by the section's own case-insensitive
    // natural key.
    const nodeIds = new Map<string, string>();
    const captureNodeId = (name: string, body: unknown): void => {
      const nodeId = (body as { node_id?: unknown } | null)?.node_id;
      if (typeof nodeId === "string") {
        nodeIds.set(pinKey(name), nodeId);
      }
    };
    /** Each entry's declared pin state, in file order (order IS the pin order). */
    const pinDeclarations: PinDeclaration[] = [];
    for (const env of desired) {
      const { settings, nested, routed } = splitEntry(env);
      const name = env.name;
      if (routed.pinned !== undefined) {
        pinDeclarations.push({ name, pinned: routed.pinned });
      }
      if (run.check) {
        const probe = await probeAbsent(ctx, this, ENDPOINTS.probe, {
          params: { environment_name: name },
        });
        if ("missing" in probe) {
          run.result.drift.push(
            `environments[${name}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
          for (const key of NESTED_KEYS) {
            if (nested[key] !== undefined) {
              run.result.notes.push(NESTED_RECONCILERS[key].missingNote(name));
            }
          }
        } else {
          run.result.drift.push(
            ...subsetDiff(settings, flattenEnvironment(probe.data), `environments[${name}]`),
          );
          const liveEnv = (probe.data ?? {}) as Record<string, unknown>;
          for (const key of NESTED_KEYS) {
            await reconcileNested(ctx, this, key, name, nested, run, liveEnv);
          }
        }
      } else {
        const updated = await call(ctx, this, ENDPOINTS.update, {
          params: { environment_name: name },
          payload: settings,
          describe: `upserting environment "${name}"`,
        });
        captureNodeId(name, updated);
        run.result.changes.push(`applied environment "${name}"`);
        for (const key of NESTED_KEYS) {
          await reconcileNested(ctx, this, key, name, nested, run, undefined);
        }
      }
    }
    // Pins reconcile AFTER every environment PUT: a declared pin's node id
    // comes from its own PUT above, and a PUT failure has already aborted
    // the section through the ordinary error flow before any pin mutation
    // could fire. Key-gated: without a declared `pinned` key the section
    // stays REST-only and never touches /graphql.
    if (pinDeclarations.length > 0) {
      await reconcilePins(ctx, this, pinDeclarations, nodeIds, run);
    }
    return run.result;
  },
} satisfies SectionModule<"environments">;

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

/**
 * The fields of a live branch policy this section reads. GitHub's spec marks
 * every one of them optional, so each is read defensively: a missing type
 * reads as the server-side default "branch", while a missing name or id is a
 * contract break that fails loudly - a policy without a name has no identity
 * to reconcile by, and silently skipping it would let check report falsely
 * clean while the default delete policy neither removed nor noted it.
 */
const LiveBranchPolicy = z.looseObject({
  id: z.number().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
});
type LiveBranchPolicy = z.infer<typeof LiveBranchPolicy>;

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
  const duplicates = new Set<string>();
  for (const pattern of entries) {
    if (seen.has(pattern.name)) {
      duplicates.add(pattern.name);
    }
    seen.add(pattern.name);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `environments: the "${env.name}" entry declares deployment branch polic${duplicates.size === 1 ? "y" : "ies"} ${[...duplicates].map((name) => `"${name}"`).join(", ")} more than once. Keep exactly one entry per pattern`,
    );
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
  run: SectionRun,
  liveEnv: Record<string, unknown> | undefined,
): Promise<void> {
  if (run.check) {
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
      run.result.notes.push(
        `environments[${envName}].deployment_branch_policies: patterns are not verifiable until custom_branch_policies is true; apply will set the flag and reconcile the declared patterns`,
      );
      return;
    }
  }
  const live = parseLive(
    section,
    ENDPOINTS.listPolicies,
    z.array(LiveBranchPolicy),
    await listAllEnveloped(ctx, section, ENDPOINTS.listPolicies, "branch_policies", {
      params: { environment_name: envName },
    }),
    `environment "${envName}"`,
  );
  const liveByName = new Map<string, LiveBranchPolicy>();
  for (const pattern of live) {
    liveByName.set(livePolicyName(pattern, envName), pattern);
  }
  const declared = new Set(entries.map((pattern) => pattern.name));

  for (const pattern of entries) {
    const label = `environments[${envName}].deployment_branch_policies[${pattern.name}]`;
    const existing = liveByName.get(pattern.name);
    if (!existing) {
      if (run.check) {
        run.result.drift.push(
          `${label}: missing - declared in the settings file but not on the environment; apply will create it`,
        );
      } else {
        await createBranchPolicy(ctx, section, envName, pattern);
        run.result.changes.push(
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
    if (run.check) {
      run.result.drift.push(
        `${label}: the declared type differs from the live pattern's, and a policy's type is immutable; apply will delete and recreate it`,
      );
      // Name the differing values; the generic line alone left the reader
      // guessing which side says what.
      run.result.drift.push(...subsetDiff({ type: desiredType }, { type: liveType }, label));
    } else {
      await call(ctx, section, ENDPOINTS.removePolicy, {
        params: { environment_name: envName, branch_policy_id: livePolicyId(existing, envName) },
        describe: `deleting deployment branch policy "${pattern.name}" in environment "${envName}" to change its immutable type`,
      });
      await createBranchPolicy(ctx, section, envName, pattern);
      run.result.changes.push(
        `replaced deployment branch policy "${pattern.name}" in environment "${envName}" (type is immutable; ${liveType} -> ${desiredType})`,
      );
    }
  }

  for (const [name, existing] of liveByName) {
    if (declared.has(name)) {
      continue;
    }
    if (policy === "keep") {
      run.result.notes.push(
        undeclaredNote({
          subject: `deployment branch policy "${name}"`,
          state: `exists on environment "${envName}" but is not declared`,
          action: "DELETE it",
        }),
      );
    } else if (run.check) {
      run.result.drift.push(
        undeclaredDrift(NESTED_RECONCILERS.deployment_branch_policies.defaultPolicy, {
          label: `environments[${envName}].deployment_branch_policies[${name}]`,
          action: "DELETE it",
        }),
      );
    } else {
      await call(ctx, section, ENDPOINTS.removePolicy, {
        params: { environment_name: envName, branch_policy_id: livePolicyId(existing, envName) },
        describe: `deleting undeclared deployment branch policy "${name}" from environment "${envName}"`,
      });
      run.result.changes.push(
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
const LiveProtectionRule = z.looseObject({
  id: z.number().optional(),
  enabled: z.boolean().optional(),
  app: z.looseObject({ id: z.number().optional(), slug: z.string().optional() }).optional(),
});
type LiveProtectionRule = z.infer<typeof LiveProtectionRule>;

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
 * PRESENT off-shape value is a contract break parseLive fails loudly.
 */
async function listProtectionRules(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
): Promise<LiveProtectionRule[]> {
  const data = parseLive(
    section,
    ENDPOINTS.listProtectionRules,
    z
      .looseObject({ custom_deployment_protection_rules: z.array(LiveProtectionRule).optional() })
      .nullable(),
    await call(ctx, section, ENDPOINTS.listProtectionRules, {
      params: { environment_name: envName },
      describe: `listing deployment protection rules of environment "${envName}"`,
    }),
    `environment "${envName}"`,
  );
  return data?.custom_deployment_protection_rules ?? [];
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
const LiveProtectionRuleApp = z.looseObject({ id: z.number(), slug: z.string() });
type LiveProtectionRuleApp = z.infer<typeof LiveProtectionRuleApp>;

/**
 * The available-Apps listing, parsed loudly at the boundary: an App without
 * a slug or id could neither be offered in the unknown-slug error nor
 * resolve a declared rule, so parseLive rejects the whole listing.
 */
async function listProtectionRuleApps(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  envName: string,
): Promise<LiveProtectionRuleApp[]> {
  return parseLive(
    section,
    ENDPOINTS.listProtectionRuleApps,
    z.array(LiveProtectionRuleApp),
    await listAllEnveloped(
      ctx,
      section,
      ENDPOINTS.listProtectionRuleApps,
      "available_custom_deployment_protection_rule_integrations",
      { params: { environment_name: envName } },
    ),
    `environment "${envName}"`,
  );
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
  const duplicates = new Set<string>();
  for (const rule of entries) {
    if (seen.has(rule.app)) {
      duplicates.add(rule.app);
    }
    seen.add(rule.app);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `environments: the "${env.name}" entry declares the deployment protection rule App${duplicates.size === 1 ? "" : "s"} ${[...duplicates].map((app) => `"${app}"`).join(", ")} more than once. Keep exactly one entry per App`,
    );
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
  run: SectionRun,
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
  if (run.check) {
    for (const rule of missing) {
      run.result.drift.push(
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
      run.result.changes.push(
        `enabled deployment protection rule "${rule.app}" in environment "${envName}"`,
      );
    }
  }

  for (const [slug, rule] of liveBySlug) {
    if (declared.has(slug)) {
      continue;
    }
    if (policy === "keep") {
      run.result.notes.push(
        undeclaredNote({
          subject: `deployment protection rule "${slug}"`,
          state: `is enabled on environment "${envName}" but is not declared`,
          action: "DISABLE it",
        }),
      );
    } else if (run.check) {
      run.result.drift.push(
        undeclaredDrift(NESTED_RECONCILERS.deployment_protection_rules.defaultPolicy, {
          label: `environments[${envName}].deployment_protection_rules[${slug}]`,
          action: "DISABLE it",
        }),
      );
    } else {
      await call(ctx, section, ENDPOINTS.removeProtectionRule, {
        params: { environment_name: envName, protection_rule_id: liveRuleId(rule, envName) },
        describe: `disabling undeclared deployment protection rule "${slug}" in environment "${envName}"`,
      });
      run.result.changes.push(
        `DISABLED undeclared deployment protection rule "${slug}" in environment "${envName}"`,
      );
    }
  }
}

// --- Pinned environments (the routed `pinned` scalar) ------------------------

/** One entry's declared pin state, in settings-file order. */
interface PinDeclaration {
  name: string;
  pinned: boolean;
}

/** The fields of one live pin this section reads off the pins connection. */
interface LivePin {
  /**
   * The ordering sort key. Verified against live GitHub as possibly
   * NON-CONTIGUOUS (unpinning leaves a hole, a new pin appends via a
   * monotonic counter; only a reorder renormalizes), so it is never compared
   * as a literal slot number - only its RANK in the sorted list matters.
   */
  position: number;
  /** The pinned environment's name. */
  name: string;
}

/**
 * One pins-connection node, with the identity fields extracted loudly (the
 * livePolicyName posture): a pin without a numeric position and a name has
 * no identity to reconcile by, and silently skipping it would let check
 * report falsely clean while apply reordered blind.
 */
function livePin(node: unknown): LivePin {
  const pin = node as { position?: unknown; environment?: { name?: unknown } } | null;
  const position = pin?.position;
  const name = pin?.environment?.name;
  if (typeof position !== "number" || typeof name !== "string") {
    throw new Error(
      `environments: the pinned-environments listing returned a pin node this section cannot read (${JSON.stringify(node) ?? String(node)}): it needs a numeric "position" and an "environment.name" string, so the declared pins cannot be reconciled. Check the "api-version" input against the GitHub GraphQL reference for pinnedEnvironments`,
    );
  }
  return { position, name };
}

/**
 * The live pins in rank order (sorted by their position field). A tolerated
 * NOT_FOUND - how GraphQL delivers a fine-grained denial on the repository -
 * reads as "no pins", the same absent posture as the section's REST probe,
 * so the denial surfaces on the first pin write instead of failing the read
 * pass.
 */
async function listLivePins(
  ctx: SectionContext,
  section: SectionModule<"environments">,
): Promise<LivePin[]> {
  const listed = await listGraphqlConnection(ctx, section, PINS_QUERY, repoVariables(ctx));
  if ("error" in listed) {
    return [];
  }
  return listed.items.map(livePin).sort((a, b) => a.position - b.position);
}

/** The pin key: environment names are case-insensitive, like the natural key. */
function pinKey(name: string): string {
  return name.toLowerCase();
}

/**
 * The complete mutation plan for the declared pin states against one live
 * pinned list - a PURE computation, shared by both modes: check renders its
 * drift lines from the plan and apply executes exactly the plan's mutations,
 * so the two cannot disagree about what apply would do. Semantics: the
 * entries declaring `pinned: true` must LEAD the pinned list in declaration
 * order (compared by rank - live position numbers may carry holes);
 * `pinned: false` unpins; pins with no declared pin state are never
 * unpinned, and when one sits among the leading ranks the declared block
 * claims, apply moves it after them (`interleaved`, surfaced as a note in
 * both modes).
 *
 * The reorders are simulated here against the post-unpin, post-append order:
 * pins append at the TAIL (verified live behavior), and each reorder pulls
 * desired[i] LEFT into rank i+1 - by the time rank i is considered, ranks
 * 0..i-1 already hold desired[0..i-1], so the target can only sit further
 * right, making remove-then-insert semantics unambiguous and one mutation
 * per out-of-place pin sufficient.
 */
function planPins(
  declarations: readonly PinDeclaration[],
  live: readonly LivePin[],
): {
  /** Display names to unpin (declared pinned: false AND live-pinned). */
  unpins: string[];
  /** Display names to pin (declared pinned: true, not live), file order. */
  pins: string[];
  /** The reorder mutations, each a leftward move to a 1-based rank. */
  reorders: Array<{ name: string; rank: number }>;
  /** Live pins with no declared pin state sitting among the leading ranks. */
  interleaved: string[];
  /** The pinned count once the plan has run (never transiently exceeded). */
  finalCount: number;
  /** The live names in rank order, for the order-drift line. */
  liveOrder: string[];
} {
  const desired = declarations.filter((entry) => entry.pinned).map((entry) => entry.name);
  const desiredKeys = new Set(desired.map(pinKey));
  const unpinKeys = new Set(
    declarations.filter((entry) => !entry.pinned).map((entry) => pinKey(entry.name)),
  );
  const liveKeys = new Set(live.map((pin) => pinKey(pin.name)));

  const unpins = declarations
    .filter((entry) => !entry.pinned && liveKeys.has(pinKey(entry.name)))
    .map((entry) => entry.name);
  const pins = desired.filter((name) => !liveKeys.has(pinKey(name)));

  // The rank order once the unpins are gone and the missing pins have
  // appended at the tail - the exact state the reorder loop starts from.
  const postUnpin = live
    .filter((pin) => !unpinKeys.has(pinKey(pin.name)))
    .map((pin) => pinKey(pin.name));
  const order = [...postUnpin, ...pins.map(pinKey)];

  const interleaved = live
    .filter(
      (pin) =>
        !desiredKeys.has(pinKey(pin.name)) &&
        !unpinKeys.has(pinKey(pin.name)) &&
        postUnpin.indexOf(pinKey(pin.name)) < desired.length,
    )
    .map((pin) => pin.name);

  const reorders: Array<{ name: string; rank: number }> = [];
  desired.forEach((name, index) => {
    const key = pinKey(name);
    if (order[index] === key) {
      return;
    }
    reorders.push({ name, rank: index + 1 });
    order.splice(order.indexOf(key), 1);
    order.splice(index, 0, key);
  });

  return {
    unpins,
    pins,
    reorders,
    interleaved,
    finalCount: postUnpin.length + pins.length,
    liveOrder: live.map((pin) => pin.name),
  };
}

/**
 * Resolve the node id of every environment the plan will mutate, BEFORE the
 * first mutation (the resolve-before-write posture of the protection-rules
 * reconciler): a body that omitted its node_id fails the section here, with
 * zero pins half-applied, instead of on the Nth mutation. The ids are
 * attached to the plan items themselves, so each mutation below carries its
 * own proof and no name-keyed lookup exists to miss.
 */
function resolvePinIds(
  nodeIds: ReadonlyMap<string, string>,
  plan: { unpins: string[]; pins: string[]; reorders: Array<{ name: string; rank: number }> },
): {
  unpins: Array<{ name: string; id: string }>;
  pins: Array<{ name: string; id: string }>;
  reorders: Array<{ name: string; rank: number; id: string }>;
} {
  const idOf = (name: string): string => {
    const nodeId = nodeIds.get(pinKey(name));
    if (nodeId === undefined) {
      throw new Error(
        `environments: the environment body for "${name}" carried no node_id, so its pin cannot be reconciled. Check the "api-version" input against the GitHub REST docs for the environments endpoint`,
      );
    }
    return nodeId;
  };
  return {
    unpins: plan.unpins.map((name) => ({ name, id: idOf(name) })),
    pins: plan.pins.map((name) => ({ name, id: idOf(name) })),
    reorders: plan.reorders.map(({ name, rank }) => ({ name, rank, id: idOf(name) })),
  };
}

/**
 * Reconcile the declared pin states against the live pinned-environments
 * list, AFTER every environment PUT (run() gates the call on a declared
 * `pinned` key, so a pin-free settings file stays REST-only). Both modes
 * read the live pins once and derive everything from planPins; apply then
 * executes the plan in an order that can never transiently exceed GitHub's
 * cap - unpins first, then pins, then the leftward reorders. The final
 * count is gated up front in both modes (the shape's cap counts only
 * DECLARED pins, and live pins nobody declared - never unpinned here - can
 * still overflow it): check surfaces the overflow as a note beside its
 * drift, apply fails before the first mutation. The per-pin UNPROCESSABLE
 * handling stays as the belt for a pin raced in between the read and the
 * mutations.
 */
async function reconcilePins(
  ctx: SectionContext,
  section: SectionModule<"environments">,
  declarations: readonly PinDeclaration[],
  nodeIds: ReadonlyMap<string, string>,
  run: SectionRun,
): Promise<void> {
  const desired = declarations.filter((entry) => entry.pinned).map((entry) => entry.name);
  const live = await listLivePins(ctx, section);
  const plan = planPins(declarations, live);

  if (plan.interleaved.length > 0) {
    run.result.notes.push(
      `pinned environment(s) ${plan.interleaved.map((name) => `"${name}"`).join(", ")} have no pinned declaration in the settings file; they stay pinned (only a pinned: false entry unpins) and apply moves them after the declared pins`,
    );
  }
  const overflow =
    plan.finalCount > MAX_PINNED_ENVIRONMENTS
      ? `pinning the ${plan.pins.length} declared environment(s) not yet pinned would leave ${plan.finalCount} environments pinned, but GitHub allows at most ${MAX_PINNED_ENVIRONMENTS}. Pins without a pinned declaration are left untouched, so declare pinned: false on entries for some of the currently pinned environments, or unpin them in the GitHub UI`
      : undefined;

  if (run.check) {
    for (const name of plan.pins) {
      run.result.drift.push(
        `environments[${name}].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it`,
      );
    }
    for (const name of plan.unpins) {
      run.result.drift.push(
        `environments[${name}].pinned: pinned on the repo but declared pinned: false; apply will unpin it`,
      );
    }
    if (plan.reorders.length > 0) {
      run.result.drift.push(
        `environments.pinned: the declared pin order is [${desired.join(", ")}] but the live pinned order is [${plan.liveOrder.join(", ")}]; apply will reorder the pins so the declared ones lead in declaration order`,
      );
    }
    if (overflow !== undefined) {
      run.result.notes.push(`apply will fail: ${overflow}`);
    }
    return;
  }

  if (overflow !== undefined) {
    throw new Error(`environments: ${overflow}`);
  }
  if (plan.unpins.length === 0 && plan.pins.length === 0 && plan.reorders.length === 0) {
    return;
  }
  const resolved = resolvePinIds(nodeIds, plan);

  for (const { name, id } of resolved.unpins) {
    await callGraphql(
      ctx,
      section,
      PIN_ENVIRONMENT,
      { environmentId: id, pinned: false },
      { describe: `unpinning environment "${name}"` },
    );
    run.result.changes.push(`unpinned environment "${name}"`);
  }
  for (const { name, id } of resolved.pins) {
    const pinned = await tryCallGraphql(
      ctx,
      section,
      PIN_ENVIRONMENT,
      { environmentId: id, pinned: true },
      { describe: `pinning environment "${name}"` },
    );
    if ("error" in pinned) {
      // The one tolerated outcome is UNPROCESSABLE: the repository's pinned
      // list is full. The settings file cannot fix that by itself (it never
      // unpins environments it does not declare), so name the way out.
      throw new Error(
        `environments: pinning environment "${name}" failed - GRAPHQL ${PIN_ENVIRONMENT.name}: ${pinned.error.status} ${pinned.error.message}. GitHub allows at most ${MAX_PINNED_ENVIRONMENTS} pinned environments, and pins without a pinned declaration are left untouched - declare pinned: false on entries for some of the currently pinned environments, or unpin them in the GitHub UI`,
      );
    }
    run.result.changes.push(`pinned environment "${name}"`);
  }
  for (const { name, rank, id } of resolved.reorders) {
    await callGraphql(
      ctx,
      section,
      REORDER_ENVIRONMENT,
      { environmentId: id, position: rank },
      { describe: `moving pinned environment "${name}" to position ${rank}` },
    );
    run.result.changes.push(`moved pinned environment "${name}" to position ${rank}`);
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
