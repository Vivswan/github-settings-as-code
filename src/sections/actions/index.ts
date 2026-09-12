import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import type { MustBeNever } from "../../types.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import { loosen, type SectionMeta, type SectionModule } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import {
  hasDrift,
  type PlanContext,
  type PlannedOp,
  plainData,
  type SectionPlan,
} from "../contract/plan.js";
import { ActionsConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["administration"] };

// The contract documents both 400 and 422 for a rejected template, so the same advice keys both.
const OIDC_TEMPLATE_HINT =
  "include_claim_keys entries must be unique claim keys of the OIDC token (alphanumeric and underscores only); see the OIDC subject claim customization endpoint documentation";

// GitHub documents this pair for private repositories and a bare 403 on the GET with no prose
// about why, so a denial here is ambiguous.
const FORK_PR_PRIVATE_DENIAL =
  "the fork PR workflow settings are documented for private repositories, so a denial here can also mean the repository is public";

const ENDPOINTS = {
  getPermissions: {
    route: "GET /repos/{owner}/{repo}/actions/permissions",
    statuses: { 200: "the Actions permissions policy" },
    primaryRead: { notFound: "denied" },
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

type ActionsContext = PlanContext<typeof ENDPOINTS>;
type ActionsOp = PlannedOp<typeof ENDPOINTS>;
type ActionsPlan = SectionPlan<ActionsOp>;

type ReadRole = keyof ActionsContext["read"];
type WriteRole = ActionsOp["role"];

/**
 * Named once so a limit's GET and PUT cannot be paired across limits: both roles derive from N,
 * and both must be declared roles.
 */
function cacheLimit<N extends string>(
  name: `getCache${N}` extends ReadRole ? (`putCache${N}` extends WriteRole ? N : never) : never,
  label: string,
): { get: `getCache${N}` & ReadRole; put: `putCache${N}` & WriteRole; label: string } {
  return {
    get: `getCache${name}` as `getCache${N}` & ReadRole,
    put: `putCache${name}` as `putCache${N}` & WriteRole,
    label,
  };
}

/** Each cache key is the whole body of its own single-field PUT. */
const CACHE_ENDPOINT_BY_KEY = {
  max_cache_retention_days: cacheLimit("Retention", "retention"),
  max_cache_size_gb: cacheLimit("Storage", "storage"),
} as const;

/**
 * The handler iterates the TABLE, so a schema field with no entry would compile and be silently
 * ignored; both an unlisted field and a phantom entry fail here instead.
 */
type CacheKey = keyof NonNullable<ActionsConfig["cache"]>;
type _CacheEndpointsComplete = MustBeNever<Exclude<CacheKey, keyof typeof CACHE_ENDPOINT_BY_KEY>>;
type _CacheEndpointsSound = MustBeNever<Exclude<keyof typeof CACHE_ENDPOINT_BY_KEY, CacheKey>>;

/**
 * Claim-key ORDER defines the OIDC subject format ("repo:...:context:..."), so unlike subsetDiff's
 * set comparison of scalar lists this one matches element by element: a reordered live value is drift.
 */
function sameClaimKeyOrder(declared: readonly string[], live: readonly string[]): boolean {
  return declared.length === live.length && declared.every((key, index) => live[index] === key);
}

// GitHub may return include_claim_keys as null or omit it; the rest of the body rides into
// subsetDiff as passthrough.
const LiveOidcSub = z.looseObject({ include_claim_keys: z.array(z.string()).nullish() });

/**
 * The routing table holds the handler itself, so a routed key without a handler cannot exist.
 * A function-valued property, not method shorthand, so the per-key value types check strictly.
 */
interface RoutedDestination<K extends keyof ActionsConfig> {
  plan: (
    ctx: ActionsContext,
    section: SectionMeta,
    declared: NonNullable<ActionsConfig[K]>,
    plan: ActionsPlan,
  ) => Promise<void>;
}

/** `N` is inferred from the GET alone, so a PUT of another name does not compile. */
export function endpointRouted<K extends keyof ActionsConfig, N extends string>(
  wiring: {
    get: `get${N}` & ReadRole;
    put: NoInfer<`put${N}`> & WriteRole;
    /** The drift-line prefix ("actions.access"). */
    label: string;
    /** The change line apply reports after the PUT lands. */
    applied: string;
    describe?: string;
  } & (NonNullable<ActionsConfig[K]> extends Record<string, unknown>
    ? { body?: (declared: NonNullable<ActionsConfig[K]>) => Record<string, unknown> }
    : { body: (declared: NonNullable<ActionsConfig[K]>) => Record<string, unknown> }),
): RoutedDestination<K> {
  const body =
    wiring.body ??
    ((declared: NonNullable<ActionsConfig[K]>) => declared as Record<string, unknown>);
  return {
    plan: async (ctx, _section, declared, plan) => {
      const live = await ctx.read[wiring.get].call();
      const payload = body(declared);
      const drift = subsetDiff(payload, live, wiring.label);
      if (hasDrift(drift)) {
        plan.ops.push({
          role: wiring.put,
          payload: plainData(payload),
          describe: wiring.describe,
          drift,
          change: wiring.applied,
        });
      }
    },
  };
}

// Every DECLARED key names its destination, so the mapped `satisfies` makes a schema field with no
// entry a compile error; a routed entry IS its handler, so routed-but-unhandled cannot exist either.
// Undeclared (future) keys fall through to the base permissions PUT verbatim, never silently dropped.
const KEY_DESTINATION = {
  enabled: "base",
  allowed_actions: "base",
  selected_actions: {
    plan: async (ctx, _section, declared, plan) => {
      // A 409 (policy not "selected") or 404 (no allowlist) is drift, not a failure; both are
      // declared statuses. The line promises only the allowlist: the policy is the base operation's own drift.
      const probe = await ctx.read.getSelected.probeAbsent();
      const drift =
        "missing" in probe
          ? [
              'actions.selected: no selected-actions allowlist is readable (the live allowed_actions policy is not "selected", or no allowlist has been set); apply will set the declared allowlist',
            ]
          : subsetDiff(declared, probe.data, "actions.selected");
      if (hasDrift(drift)) {
        plan.ops.push({
          role: "putSelected",
          payload: plainData(declared),
          drift,
          change: "applied selected-actions policy",
        });
      }
    },
  },
  default_workflow_permissions: "workflow",
  can_approve_pull_request_reviews: "workflow",
  access_level: endpointRouted({
    get: "getAccess",
    put: "putAccess",
    label: "actions.access",
    applied: "applied workflows access level",
    body: (value) => ({ access_level: value }),
  }),
  artifact_and_log_retention: endpointRouted({
    get: "getRetention",
    put: "putRetention",
    label: "actions.artifact_and_log_retention",
    applied: "applied artifact and log retention",
    describe: "setting the artifact and log retention window",
  }),
  cache: {
    plan: async (ctx, _section, declared, plan) => {
      const cache = declared as Record<string, unknown>;
      for (const [key, wiring] of Object.entries(CACHE_ENDPOINT_BY_KEY)) {
        if (!(key in cache)) {
          continue;
        }
        const live = await ctx.read[wiring.get].call();
        const body = { [key]: cache[key] };
        const drift = subsetDiff(body, live, "actions.cache");
        if (hasDrift(drift)) {
          plan.ops.push({
            role: wiring.put,
            payload: plainData(body),
            describe: `setting the cache ${wiring.label} limit`,
            drift,
            change: `applied cache ${wiring.label} limit`,
          });
        }
      }
    },
  },
  oidc_customization_sub: {
    plan: async (ctx, section, declared, plan) => {
      const live = parseLive(
        section,
        ENDPOINTS.getOidcSub,
        LiveOidcSub,
        await ctx.read.getOidcSub.call(),
      );
      const { include_claim_keys, ...comparable } = declared;
      const drift = subsetDiff(comparable, live, "actions.oidc_customization_sub");
      // GitHub ignores include_claim_keys when use_default is true, and an OMITTED list on a custom
      // template is itself meaningful upstream (it opts the repository into the organization
      // template, whose keys then show up live), so the list is compared only when the file declares it.
      if (declared.use_default === false && include_claim_keys !== undefined) {
        const liveKeys = live.include_claim_keys ?? [];
        if (!sameClaimKeyOrder(include_claim_keys, liveKeys)) {
          drift.push(
            `actions.oidc_customization_sub.include_claim_keys: declared ${JSON.stringify(include_claim_keys)} != live ${JSON.stringify(liveKeys)} (claim-key order defines the subject format, so order counts); apply will set the declared value`,
          );
        }
      }
      if (hasDrift(drift)) {
        plan.ops.push({
          role: "putOidcSub",
          payload: plainData(declared),
          describe: "customizing the OIDC subject claim",
          drift,
          change: "applied the OIDC subject claim template",
        });
      }
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

type RoutedKey = {
  [K in keyof ActionsConfig]-?: (typeof KEY_DESTINATION)[K] extends string ? never : K;
}[keyof ActionsConfig];

// Per-key handler types, so planRouted's generic dispatch stays correlated to one literal key.
const ROUTED_DESTINATIONS: { [K in RoutedKey]: RoutedDestination<K> } = KEY_DESTINATION;

const ROUTED_KEYS = (Object.keys(KEY_DESTINATION) as (keyof ActionsConfig)[]).filter(
  (key): key is RoutedKey => typeof KEY_DESTINATION[key] !== "string",
);

const ROUTED_KEY_SET: ReadonlySet<string> = new Set(ROUTED_KEYS);

async function planRouted<K extends RoutedKey>(
  key: K,
  ctx: ActionsContext,
  section: SectionMeta,
  desired: ActionsConfig,
  plan: ActionsPlan,
): Promise<void> {
  const declared = desired[key];
  if (declared === undefined) {
    return;
  }
  await ROUTED_DESTINATIONS[key].plan(ctx, section, declared, plan);
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
  async plan(ctx, desired) {
    const plan: ActionsPlan = { ops: [], notes: [], drift: [] };
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
    if (desired.selected_actions !== undefined && permissions.allowed_actions === undefined) {
      // The allowlist endpoint answers 409 unless the policy is "selected", so an undeclared policy
      // is inferred; a contradicting declared one is rejected upfront by the shape's superRefine.
      permissions.allowed_actions = "selected";
    }
    if (Object.keys(permissions).length > 0) {
      // The PUT body requires `enabled`; declaring any base-permissions key implies actions are on
      // unless the file says otherwise.
      permissions.enabled = permissions.enabled ?? true;
    }
    const routed = Object.keys(permissions).filter((k) => !KNOWN_PERMISSION_KEYS.has(k));
    if (routed.length > 0) {
      // The base PUT body always carries an enabled value (defaulted above), so a mis-routed key can
      // flip Actions on as a side effect; the note says so. JSON.stringify keeps a malformed quoted
      // "false" distinguishable from the boolean.
      const enabledValue = JSON.stringify(permissions.enabled);
      plan.notes.push(
        `key(s) [${routed.join(", ")}] are not recognized by this action; they ride verbatim ` +
          `in PUT /actions/permissions (a body that also sets enabled: ${enabledValue}), where ` +
          `GitHub may ignore them - a "no such field" drift line for a key means GitHub does not ` +
          `return it, so it can never be proven to have taken and apply would re-send the body ` +
          `on every run; remove it from the actions section of the settings file`,
      );
    }

    if (Object.keys(permissions).length > 0) {
      const drift = subsetDiff(
        permissions,
        await ctx.read.getPermissions.call(),
        "actions.permissions",
      );
      if (hasDrift(drift)) {
        plan.ops.push({
          role: "putPermissions",
          payload: plainData(permissions),
          drift,
          change: "applied actions permissions",
        });
      }
    }
    if (Object.keys(workflow).length > 0) {
      const drift = subsetDiff(workflow, await ctx.read.getWorkflow.call(), "actions.workflow");
      if (hasDrift(drift)) {
        plan.ops.push({
          role: "putWorkflow",
          payload: plainData(workflow),
          drift,
          change: "applied workflow token permissions",
        });
      }
    }
    // The routed keys plan after the base permissions PUT above: the selected-actions PUT 409s
    // until the policy is "selected".
    for (const key of ROUTED_KEYS) {
      await planRouted(key, ctx, this, desired, plan);
    }
    return plan;
  },
} satisfies SectionModule<"actions", typeof ENDPOINTS>;
