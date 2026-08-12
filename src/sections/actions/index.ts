/**
 * `actions:` section - a key router across the Actions settings endpoints
 * (base permissions, selected-actions allowlist, workflow token defaults,
 * access level, artifact/log retention, cache limits, OIDC subject claim,
 * fork pull request workflow policies), with unknown keys passed through
 * verbatim to the base permissions PUT.
 */

import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import type { MustBeNever } from "../../types.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  beginRun,
  loosen,
  type SectionContext,
  type SectionModule,
  type SectionResult,
  type SectionRun,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { call, probeAbsent } from "../contract/requests.js";
import { ActionsConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["administration"] };

// The contract documents both 400 and 422 for a rejected template, so the
// same advice keys both statuses.
const OIDC_TEMPLATE_HINT =
  "include_claim_keys entries must be unique claim keys of the OIDC token (alphanumeric and underscores only); see the OIDC subject claim customization endpoint documentation";

// The fork-pr-workflows-private-repos pair is documented for private
// repositories, and the contract documents a bare 403 on the GET with no
// prose about why; a denial here is therefore ambiguous.
const FORK_PR_PRIVATE_DENIAL =
  "the fork PR workflow settings are documented for private repositories, so a denial here can also mean the repository is public";

const ENDPOINTS = {
  getPermissions: {
    route: "GET /repos/{owner}/{repo}/actions/permissions",
    statuses: { 200: "the Actions permissions policy" },
  },
  putPermissions: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions",
    statuses: { 204: "Actions permissions policy applied" },
  },
  getSelected: {
    route: "GET /repos/{owner}/{repo}/actions/permissions/selected-actions",
    statuses: {
      200: "the selected-actions allowlist",
      404: "no allowlist because the policy is not selected",
      409: "the allowed_actions policy is not selected, so the allowlist does not apply",
    },
  },
  putSelected: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions/selected-actions",
    statuses: { 204: "selected-actions allowlist applied" },
  },
  getWorkflow: {
    route: "GET /repos/{owner}/{repo}/actions/permissions/workflow",
    statuses: { 200: "the workflow token permissions" },
  },
  putWorkflow: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions/workflow",
    statuses: { 204: "workflow token permissions applied" },
  },
  getAccess: {
    route: "GET /repos/{owner}/{repo}/actions/permissions/access",
    statuses: { 200: "the workflows access level" },
  },
  putAccess: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions/access",
    statuses: { 204: "workflows access level applied" },
  },
  getRetention: {
    route: "GET /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention",
    statuses: { 200: "the artifact and log retention window" },
  },
  putRetention: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention",
    statuses: { 204: "artifact and log retention applied" },
    hints: {
      422: "the retention window must be a whole number of days within the plan's maximum; see the artifact-and-log-retention endpoint documentation",
    },
  },
  getCacheRetention: {
    route: "GET /repos/{owner}/{repo}/actions/cache/retention-limit",
    statuses: { 200: "the cache retention limit" },
  },
  putCacheRetention: {
    route: "PUT /repos/{owner}/{repo}/actions/cache/retention-limit",
    statuses: { 204: "cache retention limit applied" },
    hints: {
      400: "the retention limit must be a whole number of days within the allowed range; see the cache retention-limit endpoint documentation",
    },
  },
  getCacheStorage: {
    route: "GET /repos/{owner}/{repo}/actions/cache/storage-limit",
    statuses: { 200: "the cache storage limit" },
  },
  putCacheStorage: {
    route: "PUT /repos/{owner}/{repo}/actions/cache/storage-limit",
    statuses: { 204: "cache storage limit applied" },
    hints: {
      400: "the storage limit must be a whole number of gigabytes within the allowed range; see the cache storage-limit endpoint documentation",
    },
  },
  getOidcSub: {
    route: "GET /repos/{owner}/{repo}/actions/oidc/customization/sub",
    statuses: { 200: "the OIDC subject claim template" },
    permission: { repo: ["actions"] },
  },
  putOidcSub: {
    route: "PUT /repos/{owner}/{repo}/actions/oidc/customization/sub",
    statuses: { 201: "OIDC subject claim template applied" },
    permission: { repo: ["actions"] },
    hints: { 400: OIDC_TEMPLATE_HINT, 422: OIDC_TEMPLATE_HINT },
  },
  getForkPrApproval: {
    route: "GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval",
    statuses: { 200: "the fork PR contributor approval policy" },
  },
  putForkPrApproval: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval",
    statuses: { 204: "fork PR contributor approval policy applied" },
    hints: {
      422: "approval_policy must be one of the contributor approval policies GitHub accepts; see the fork-pr-contributor-approval endpoint documentation",
    },
  },
  getForkPrPrivate: {
    route: "GET /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos",
    statuses: { 200: "the private-repo fork PR workflow settings" },
    denialHint: FORK_PR_PRIVATE_DENIAL,
  },
  putForkPrPrivate: {
    route: "PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos",
    statuses: { 204: "private-repo fork PR workflow settings applied" },
    denialHint: FORK_PR_PRIVATE_DENIAL,
    hints: {
      422: "the settings object must carry run_workflows_from_fork_pull_requests with boolean toggles only; see the fork-pr-workflows-private-repos endpoint documentation",
    },
  },
} as const satisfies Record<string, EndpointDecl>;

/**
 * The cache object's keys: each is the whole body of its own single-field
 * PUT, and `label` names it in change lines and describe prose (kept here
 * so a future third key cannot be silently mislabeled by a stale ternary).
 */
const CACHE_ENDPOINT_BY_KEY = {
  max_cache_retention_days: {
    get: "getCacheRetention",
    put: "putCacheRetention",
    label: "retention",
  },
  max_cache_size_gb: { get: "getCacheStorage", put: "putCacheStorage", label: "storage" },
} as const;

/**
 * Compile-time lockstep between the cache config's fields and the endpoint
 * table: the handlers below iterate the TABLE, so a new schema field with no
 * entry would compile and then be rejected at run time (after earlier
 * sections wrote) by the unknown-key backstop - fail it here instead. Both
 * directions: an unlisted field and a phantom entry are each a compile error.
 */
type CacheKey = keyof NonNullable<ActionsConfig["cache"]>;
type _CacheEndpointsComplete = MustBeNever<Exclude<CacheKey, keyof typeof CACHE_ENDPOINT_BY_KEY>>;
type _CacheEndpointsSound = MustBeNever<Exclude<keyof typeof CACHE_ENDPOINT_BY_KEY, CacheKey>>;

/**
 * Claim-key ORDER defines the OIDC subject format ("repo:...:context:..."),
 * so unlike subsetDiff's scalar-list set comparison, this list must match
 * element by element - a reordered live value is drift.
 */
function sameClaimKeyOrder(declared: readonly string[], live: readonly string[]): boolean {
  return declared.length === live.length && declared.every((key, index) => live[index] === key);
}

/**
 * The OIDC subject-claim GET fields this section reads BY NAME: the claim-key
 * list (order-sensitive, compared above; nullish absorbs a null or omitted
 * list exactly as the pre-parse code did); the rest of the body rides into
 * subsetDiff as passthrough.
 */
const LiveOidcSub = z.looseObject({ include_claim_keys: z.array(z.string()).nullish() });

/**
 * A key served by its own endpoint pair: how check diffs the declared value
 * and how apply writes it. The routing table holds these handlers DIRECTLY,
 * so marking a key as endpoint-routed and implementing it are the same act -
 * a bare tag naming a destination no branch serves cannot exist. Generic
 * over the key so the declared value stays typed; function-valued
 * properties on purpose, not method shorthand, so the per-key value types
 * check strictly (the environments NESTED_RECONCILERS precedent).
 */
interface RoutedDestination<K extends keyof ActionsConfig> {
  /** Diff the declared value against its own GET; check mode only. */
  check: (
    ctx: SectionContext,
    section: SectionModule<"actions">,
    declared: NonNullable<ActionsConfig[K]>,
    run: CheckRun,
  ) => Promise<void>;
  /** PUT the declared value and report the change; apply mode only. */
  apply: (
    ctx: SectionContext,
    section: SectionModule<"actions">,
    declared: NonNullable<ActionsConfig[K]>,
    run: ApplyRun,
  ) => Promise<void>;
}

/**
 * The mode arms of SectionRun, so each table phase receives the run already
 * narrowed to its mode: a check handler structurally cannot push a change
 * line, and an apply handler cannot push drift.
 */
type CheckRun = Extract<SectionRun, { check: true }>;
type ApplyRun = Extract<SectionRun, { check: false }>;

/**
 * The standard routed-key handling - check GETs the live object and diffs
 * the declared body against it under `label`; apply PUTs the body and
 * reports `applied` - for keys whose endpoint pair speaks the declared
 * value directly. The irregular keys (selected_actions' absent-policy
 * probe, cache's two single-field endpoints, the OIDC claim-key order)
 * spell their own phases in the table instead.
 */
function endpointRouted<V = unknown>(wiring: {
  /** The GET role in ENDPOINTS check reads. */
  get: keyof typeof ENDPOINTS;
  /** The PUT role in ENDPOINTS apply writes. */
  put: keyof typeof ENDPOINTS;
  /** The drift-line prefix ("actions.access"). */
  label: string;
  /** The change line apply reports after the PUT lands. */
  applied: string;
  /** describe prose for the PUT, where the section spells one. */
  describe?: string;
  /** The PUT/diff body for the declared value (default: the value itself). */
  body?: (declared: V) => unknown;
}): {
  check: (
    ctx: SectionContext,
    section: SectionModule<"actions">,
    declared: V,
    run: CheckRun,
  ) => Promise<void>;
  apply: (
    ctx: SectionContext,
    section: SectionModule<"actions">,
    declared: V,
    run: ApplyRun,
  ) => Promise<void>;
} {
  const body = wiring.body ?? ((declared: V): unknown => declared);
  return {
    check: async (ctx, section, declared, run) => {
      const live = await call(ctx, section, ENDPOINTS[wiring.get]);
      run.result.drift.push(...subsetDiff(body(declared), live, wiring.label));
    },
    apply: async (ctx, section, declared, run) => {
      await call(ctx, section, ENDPOINTS[wiring.put], {
        payload: body(declared),
        describe: wiring.describe,
      });
      run.result.changes.push(wiring.applied);
    },
  };
}

// Forward-compatible key routing: every DECLARED ActionsConfig key names its
// destination here - "base" and "workflow" keys merge into those two PUT
// bodies, and a key with its own endpoint pair carries the HANDLER that
// serves it. The mapped `satisfies` makes a new schema field with no routing
// entry a compile error (the "documented but unrouted" state cannot exist),
// and because the routed entry is the handler itself, "routed but unhandled"
// cannot exist either. Undeclared (future) keys fall through to the base
// permissions PUT verbatim - never silently dropped.
const KEY_DESTINATION = {
  enabled: "base",
  allowed_actions: "base",
  selected_actions: {
    check: async (ctx, section, declared, run) => {
      // This GET errors (409) when the live allowed_actions policy is not
      // "selected"; that is drift, not a failure. The declared statuses
      // (200, 409, 404) make 409 and 404 tolerated automatically.
      const probe = await probeAbsent(ctx, section, ENDPOINTS.getSelected);
      if ("missing" in probe) {
        run.result.drift.push(
          'actions.selected: the live allowed_actions policy is not "selected", so no selected-actions allowlist exists; apply will set the declared policy and allowlist',
        );
      } else {
        run.result.drift.push(...subsetDiff(declared, probe.data, "actions.selected"));
      }
    },
    apply: async (ctx, section, declared, run) => {
      await call(ctx, section, ENDPOINTS.putSelected, { payload: declared });
      run.result.changes.push("applied selected-actions policy");
    },
  },
  default_workflow_permissions: "workflow",
  can_approve_pull_request_reviews: "workflow",
  access_level: endpointRouted({
    get: "getAccess",
    put: "putAccess",
    label: "actions.access",
    applied: "applied workflows access level",
    body: (value: unknown) => ({ access_level: value }),
  }),
  artifact_and_log_retention: endpointRouted({
    get: "getRetention",
    put: "putRetention",
    label: "actions.artifact_and_log_retention",
    applied: "applied artifact and log retention",
    describe: "setting the artifact and log retention window",
  }),
  cache: {
    check: async (ctx, section, declared, run) => {
      const cache = declared as Record<string, unknown>;
      for (const [key, wiring] of Object.entries(CACHE_ENDPOINT_BY_KEY)) {
        if (!(key in cache)) {
          continue;
        }
        const live = await call(ctx, section, ENDPOINTS[wiring.get]);
        run.result.drift.push(...subsetDiff({ [key]: cache[key] }, live, "actions.cache"));
      }
    },
    apply: async (ctx, section, declared, run) => {
      const cache = declared as Record<string, unknown>;
      for (const [key, wiring] of Object.entries(CACHE_ENDPOINT_BY_KEY)) {
        if (!(key in cache)) {
          continue;
        }
        await call(ctx, section, ENDPOINTS[wiring.put], {
          payload: { [key]: cache[key] },
          describe: `setting the cache ${wiring.label} limit`,
        });
        run.result.changes.push(`applied cache ${wiring.label} limit`);
      }
    },
  },
  oidc_customization_sub: {
    check: async (ctx, section, declared, run) => {
      const live = parseLive(
        section,
        ENDPOINTS.getOidcSub,
        LiveOidcSub,
        await call(ctx, section, ENDPOINTS.getOidcSub),
      );
      // The claim-key list is special-cased below; everything ELSE in the
      // declared object (use_default today, future fields tomorrow) rides
      // the PUT verbatim, so it must be diffed verbatim too - the expiry
      // precedent: exclude the special field, compare the remainder.
      const { include_claim_keys, ...comparable } = declared;
      run.result.drift.push(...subsetDiff(comparable, live, "actions.oidc_customization_sub"));
      // GitHub ignores include_claim_keys when use_default is true, and
      // an OMITTED list on a custom template is itself meaningful
      // upstream (it opts the repository into the organization template,
      // whose keys then show up live). So the list is compared only when
      // the file declares it - declared-keys-only, like everything else.
      if (declared.use_default === false && include_claim_keys !== undefined) {
        const liveKeys = live.include_claim_keys ?? [];
        if (!sameClaimKeyOrder(include_claim_keys, liveKeys)) {
          run.result.drift.push(
            `actions.oidc_customization_sub.include_claim_keys: declared ${JSON.stringify(include_claim_keys)} != live ${JSON.stringify(liveKeys)} (claim-key order defines the subject format, so order counts); apply will set the declared value`,
          );
        }
      }
    },
    apply: async (ctx, section, declared, run) => {
      await call(ctx, section, ENDPOINTS.putOidcSub, {
        payload: declared,
        describe: "customizing the OIDC subject claim",
      });
      run.result.changes.push("applied the OIDC subject claim template");
    },
  },
  fork_pr_contributor_approval: endpointRouted({
    get: "getForkPrApproval",
    put: "putForkPrApproval",
    label: "actions.fork_pr_contributor_approval",
    applied: "applied the fork PR contributor approval policy",
    describe: "setting the fork PR contributor approval policy",
  }),
  fork_pr_workflows_private_repos: endpointRouted({
    get: "getForkPrPrivate",
    put: "putForkPrPrivate",
    label: "actions.fork_pr_workflows_private_repos",
    applied: "applied the private-repo fork PR workflow settings",
    describe: "setting the private-repo fork PR workflow settings",
  }),
} satisfies { [K in keyof ActionsConfig]-?: "base" | "workflow" | RoutedDestination<K> };

/** The keys served by their own endpoint pair, as the table declares them. */
type RoutedKey = {
  [K in keyof ActionsConfig]-?: (typeof KEY_DESTINATION)[K] extends string ? never : K;
}[keyof ActionsConfig];

/**
 * The routing table's endpoint-routed slice under per-key handler types, so
 * the generic dispatch in runRouted() stays correlated to one literal key
 * (the environments NESTED_RECONCILERS pattern).
 */
const ROUTED_DESTINATIONS: { [K in RoutedKey]: RoutedDestination<K> } = KEY_DESTINATION;

/** Routed keys in table order - the order check and apply visit them. */
const ROUTED_KEYS = (Object.keys(KEY_DESTINATION) as (keyof ActionsConfig)[]).filter(
  (key): key is RoutedKey => typeof KEY_DESTINATION[key] !== "string",
);

/** Routed keys as plain strings, for the base/workflow body split. */
const ROUTED_KEY_SET: ReadonlySet<string> = new Set(ROUTED_KEYS);

/**
 * Run one routed key's phase for the run's mode; generic so the handler and
 * the declared value stay correlated to the same literal key. A key the
 * file does not declare is skipped.
 */
async function runRouted<K extends RoutedKey>(
  key: K,
  ctx: SectionContext,
  section: SectionModule<"actions">,
  desired: ActionsConfig,
  run: SectionRun,
): Promise<void> {
  const declared = desired[key];
  if (declared === undefined) {
    return;
  }
  const destination = ROUTED_DESTINATIONS[key];
  if (run.check) {
    await destination.check(ctx, section, declared, run);
  } else {
    await destination.apply(ctx, section, declared, run);
  }
}

function keysTo(destination: "base" | "workflow"): Set<string> {
  return new Set(
    Object.entries(KEY_DESTINATION)
      .filter(([, dest]) => dest === destination)
      .map(([key]) => key),
  );
}

const WORKFLOW_KEYS = keysTo("workflow");

const KNOWN_PERMISSION_KEYS = keysTo("base");

export const actionsSection = {
  key: "actions",
  undeclaredDefault: "untouched",
  permission,
  grantCaveat: 'the "oidc_customization_sub" key alone instead needs "Actions" (read and write)',
  endpoints: ENDPOINTS,
  shape: loosen(ActionsConfig),
  async run(ctx, desired): Promise<SectionResult> {
    const run = beginRun(ctx);
    const permissions: Record<string, unknown> = {};
    const workflow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
      if (ROUTED_KEY_SET.has(key)) {
        continue;
      }
      if (WORKFLOW_KEYS.has(key)) {
        workflow[key] = value;
      } else {
        permissions[key] = value;
      }
    }
    const cache = (desired.cache ?? {}) as Record<string, unknown>;
    // Backstop for the shape's one blind spot: zod's strictObject ignores an
    // own "__proto__" key, and run() sees the ORIGINAL document (validate.ts
    // applies the raw values, not zod's clone). Unlike the shape rejection,
    // this throws from run(), so earlier sections may already have applied.
    const unknownCacheKeys = Object.keys(cache).filter(
      (k) => !Object.hasOwn(CACHE_ENDPOINT_BY_KEY, k),
    );
    if (unknownCacheKeys.length > 0) {
      throw new Error(
        `actions.cache: unrecognized key(s) ${unknownCacheKeys.map((k) => `"${k}"`).join(", ")} (known keys: ${Object.keys(CACHE_ENDPOINT_BY_KEY).join(", ")}). Each cache limit is the entire body of its own endpoint, so an extra key has no destination; fix the key name, or remove it`,
      );
    }
    if (desired.selected_actions !== undefined && permissions.allowed_actions === undefined) {
      // The allowlist endpoint answers 409 unless the policy is "selected";
      // infer the policy when it is undeclared (a contradicting declared
      // policy is rejected upfront by the shape's superRefine).
      permissions.allowed_actions = "selected";
    }
    if (Object.keys(permissions).length > 0) {
      // The PUT body requires `enabled`; declaring any base-permissions key
      // implies actions are on unless said otherwise.
      permissions.enabled = permissions.enabled ?? true;
    }
    const routed = Object.keys(permissions).filter((k) => !KNOWN_PERMISSION_KEYS.has(k));
    if (routed.length > 0) {
      // The base PUT body always carries an enabled value (defaulted above),
      // so a mis-routed key can flip Actions on as a side effect; say so.
      // JSON.stringify keeps a malformed quoted "false" distinguishable from
      // the boolean in the message.
      const enabledValue = JSON.stringify(permissions.enabled);
      run.result.notes.push(
        run.check
          ? `key(s) [${routed.join(", ")}] are not recognized by this action; apply would send them verbatim to PUT /actions/permissions (a body that also sets enabled: ${enabledValue}), where GitHub may ignore them - a "no such field" drift line for a key below means GitHub does not accept it there; remove it from the actions section of the settings file`
          : `key(s) [${routed.join(", ")}] are not recognized by this action; they were sent verbatim to PUT /actions/permissions (a body that also sets enabled: ${enabledValue}), where GitHub may ignore them - run mode: check to confirm they took effect, or remove them from the actions section of the settings file`,
      );
    }

    if (Object.keys(permissions).length > 0) {
      if (run.check) {
        const live = await call(ctx, this, ENDPOINTS.getPermissions);
        run.result.drift.push(...subsetDiff(permissions, live, "actions.permissions"));
      } else {
        await call(ctx, this, ENDPOINTS.putPermissions, { payload: permissions });
        run.result.changes.push("applied actions permissions");
      }
    }
    if (Object.keys(workflow).length > 0) {
      if (run.check) {
        const live = await call(ctx, this, ENDPOINTS.getWorkflow);
        run.result.drift.push(...subsetDiff(workflow, live, "actions.workflow"));
      } else {
        await call(ctx, this, ENDPOINTS.putWorkflow, { payload: workflow });
        run.result.changes.push("applied workflow token permissions");
      }
    }
    // Every key with its own endpoint pair runs through its table handler,
    // in table order.
    for (const key of ROUTED_KEYS) {
      await runRouted(key, ctx, this, desired, run);
    }
    return run.result;
  },
} satisfies SectionModule<"actions">;
