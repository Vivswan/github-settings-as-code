/**
 * `actions:` section - a key router across the Actions settings endpoints
 * (base permissions, selected-actions allowlist, workflow token defaults,
 * access level, artifact/log retention, cache limits, OIDC subject claim,
 * fork pull request workflow policies), with unknown keys passed through
 * verbatim to the base permissions PUT.
 */

import { z } from "zod";
import { subsetDiff } from "../engine/diff.js";
import type { ActionsConfig } from "../schema.js";
import {
  call,
  type EndpointDecl,
  emptyResult,
  grantFor,
  probeAbsent,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
} from "./contract.js";

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

// Forward-compatible key routing: every DECLARED ActionsConfig key names its
// destination here, and the `satisfies Record<keyof ActionsConfig, ...>`
// makes a new schema field with no routing entry a compile error (the
// "documented but unrouted" state cannot exist). Undeclared (future) keys
// fall through to the base permissions PUT verbatim - never silently
// dropped.
const KEY_DESTINATION = {
  enabled: "base",
  allowed_actions: "base",
  selected_actions: "own-endpoint",
  default_workflow_permissions: "workflow",
  can_approve_pull_request_reviews: "workflow",
  access_level: "own-endpoint",
  artifact_and_log_retention: "own-endpoint",
  cache: "own-endpoint",
  oidc_customization_sub: "own-endpoint",
  fork_pr_contributor_approval: "own-endpoint",
  fork_pr_workflows_private_repos: "own-endpoint",
} as const satisfies Record<keyof ActionsConfig, "base" | "workflow" | "own-endpoint">;

function keysTo(destination: "base" | "workflow" | "own-endpoint"): Set<string> {
  return new Set(
    Object.entries(KEY_DESTINATION)
      .filter(([, dest]) => dest === destination)
      .map(([key]) => key),
  );
}

const WORKFLOW_KEYS = keysTo("workflow");

const KNOWN_PERMISSION_KEYS = keysTo("base");

/** Keys with their own sub-endpoint, excluded from the base permissions PUT. */
const ROUTED_KEYS = keysTo("own-endpoint");

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
 * Claim-key ORDER defines the OIDC subject format ("repo:...:context:..."),
 * so unlike subsetDiff's scalar-list set comparison, this list must match
 * element by element - a reordered live value is drift.
 */
function sameClaimKeyOrder(declared: readonly string[], live: readonly unknown[]): boolean {
  return declared.length === live.length && declared.every((key, index) => live[index] === key);
}

/**
 * Top level and retention stay loose (unknown keys pass through to their
 * PUT bodies verbatim), but cache is strict: each cache limit is the entire
 * body of its own endpoint, so an unrecognized cache key has no passthrough
 * destination and can only be a typo. Rejected upfront by validate.ts,
 * before any section writes.
 */
const shape = z.looseObject({
  artifact_and_log_retention: z.looseObject({ days: z.number() }).optional(),
  cache: z
    .strictObject({
      max_cache_retention_days: z.number().optional(),
      max_cache_size_gb: z.number().optional(),
    })
    .optional(),
  // The positional claim-key comparator below needs a shape-guaranteed
  // string array, and the subject-format flag is a YAML boolean-gotcha
  // magnet; the rest of the object stays loose (future fields ride the
  // PUT verbatim).
  oidc_customization_sub: z
    .looseObject({
      use_default: z.boolean(),
      include_claim_keys: z.array(z.string()).optional(),
      use_immutable_subject: z.boolean().optional(),
    })
    .optional(),
  // The one field each PUT requires must be present before any section
  // writes (the private-repos flag is also a YAML boolean-gotcha magnet);
  // the rest of each object rides the PUT verbatim.
  fork_pr_contributor_approval: z.looseObject({ approval_policy: z.string() }).optional(),
  // All four toggles are REQUIRED: GitHub does not document whether an
  // omitted toggle is preserved or reset by the PUT, so the file declares
  // the complete policy and upstream omission semantics can never matter.
  // Future fields still ride the looseObject verbatim.
  fork_pr_workflows_private_repos: z
    .looseObject({
      run_workflows_from_fork_pull_requests: z.boolean(),
      send_write_tokens_to_workflows: z.boolean(),
      send_secrets_and_variables: z.boolean(),
      require_approval_for_fork_pr_workflows: z.boolean(),
    })
    .optional(),
});

export const actionsSection: SectionModule<"actions"> = {
  key: "actions",
  undeclaredDefault: "untouched",
  permission,
  grant: grantFor(
    permission,
    'the "oidc_customization_sub" key alone instead needs "Actions" (read and write)',
  ),
  endpoints: ENDPOINTS,
  shape,
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const desired = desiredRaw as ActionsConfig;
    const permissions: Record<string, unknown> = {};
    const workflow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(desired as Record<string, unknown>)) {
      if (ROUTED_KEYS.has(key)) {
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
    if (desired.selected_actions !== undefined) {
      // The allowlist endpoint answers 409 unless the policy is "selected";
      // infer the policy when it is undeclared, reject a contradiction.
      if (permissions.allowed_actions === undefined) {
        permissions.allowed_actions = "selected";
      } else if (permissions.allowed_actions !== "selected") {
        throw new Error(
          `actions: selected_actions is declared together with allowed_actions: "${permissions.allowed_actions}", but an allowlist only applies under allowed_actions: "selected". Set allowed_actions to "selected", or remove selected_actions`,
        );
      }
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
      result.notes.push(
        ctx.check
          ? `key(s) [${routed.join(", ")}] are not recognized by this action; apply would send them verbatim to PUT /actions/permissions (a body that also sets enabled: ${enabledValue}), where GitHub may ignore them - a "no such field" drift line for a key below means GitHub does not accept it there; remove it from the actions section of the settings file`
          : `key(s) [${routed.join(", ")}] are not recognized by this action; they were sent verbatim to PUT /actions/permissions (a body that also sets enabled: ${enabledValue}), where GitHub may ignore them - run mode: check to confirm they took effect, or remove them from the actions section of the settings file`,
      );
    }

    if (ctx.check) {
      if (Object.keys(permissions).length > 0) {
        const live = await call(ctx, this, ENDPOINTS.getPermissions);
        result.drift.push(...subsetDiff(permissions, live, "actions.permissions"));
      }
      if (desired.selected_actions !== undefined) {
        // This GET errors (409) when the live allowed_actions policy is not
        // "selected"; that is drift, not a failure. The declared statuses
        // (200, 409, 404) make 409 and 404 tolerated automatically.
        const probe = await probeAbsent(ctx, this, ENDPOINTS.getSelected);
        if ("missing" in probe) {
          result.drift.push(
            'actions.selected: the live allowed_actions policy is not "selected", so no selected-actions allowlist exists; apply will set the declared policy and allowlist',
          );
        } else {
          result.drift.push(
            ...subsetDiff(desired.selected_actions, probe.data, "actions.selected"),
          );
        }
      }
      if (Object.keys(workflow).length > 0) {
        const live = await call(ctx, this, ENDPOINTS.getWorkflow);
        result.drift.push(...subsetDiff(workflow, live, "actions.workflow"));
      }
      if (desired.access_level !== undefined) {
        const live = await call(ctx, this, ENDPOINTS.getAccess);
        result.drift.push(
          ...subsetDiff({ access_level: desired.access_level }, live, "actions.access"),
        );
      }
      if (desired.artifact_and_log_retention !== undefined) {
        const live = await call(ctx, this, ENDPOINTS.getRetention);
        result.drift.push(
          ...subsetDiff(
            desired.artifact_and_log_retention,
            live,
            "actions.artifact_and_log_retention",
          ),
        );
      }
      for (const [key, roles] of Object.entries(CACHE_ENDPOINT_BY_KEY)) {
        if (!(key in cache)) {
          continue;
        }
        const live = await call(ctx, this, ENDPOINTS[roles.get]);
        result.drift.push(...subsetDiff({ [key]: cache[key] }, live, "actions.cache"));
      }
      if (desired.oidc_customization_sub !== undefined) {
        const declared = desired.oidc_customization_sub;
        const live = (await call(ctx, this, ENDPOINTS.getOidcSub)) as Record<string, unknown>;
        // The claim-key list is special-cased below; everything ELSE in the
        // declared object (use_default today, future fields tomorrow) rides
        // the PUT verbatim, so it must be diffed verbatim too - the expiry
        // precedent: exclude the special field, compare the remainder.
        const { include_claim_keys, ...comparable } = declared;
        result.drift.push(...subsetDiff(comparable, live, "actions.oidc_customization_sub"));
        // GitHub ignores include_claim_keys when use_default is true, and
        // an OMITTED list on a custom template is itself meaningful
        // upstream (it opts the repository into the organization template,
        // whose keys then show up live). So the list is compared only when
        // the file declares it - declared-keys-only, like everything else.
        if (declared.use_default === false && include_claim_keys !== undefined) {
          const liveKeys = Array.isArray(live.include_claim_keys) ? live.include_claim_keys : [];
          if (!sameClaimKeyOrder(include_claim_keys, liveKeys)) {
            result.drift.push(
              `actions.oidc_customization_sub.include_claim_keys: declared ${JSON.stringify(include_claim_keys)} != live ${JSON.stringify(liveKeys)} (claim-key order defines the subject format, so order counts); apply will set the declared value`,
            );
          }
        }
      }
      if (desired.fork_pr_contributor_approval !== undefined) {
        const live = await call(ctx, this, ENDPOINTS.getForkPrApproval);
        result.drift.push(
          ...subsetDiff(
            desired.fork_pr_contributor_approval,
            live,
            "actions.fork_pr_contributor_approval",
          ),
        );
      }
      if (desired.fork_pr_workflows_private_repos !== undefined) {
        const live = await call(ctx, this, ENDPOINTS.getForkPrPrivate);
        result.drift.push(
          ...subsetDiff(
            desired.fork_pr_workflows_private_repos,
            live,
            "actions.fork_pr_workflows_private_repos",
          ),
        );
      }
      return result;
    }

    if (Object.keys(permissions).length > 0) {
      await call(ctx, this, ENDPOINTS.putPermissions, { payload: permissions });
      result.changes.push("applied actions permissions");
    }
    if (desired.selected_actions !== undefined) {
      await call(ctx, this, ENDPOINTS.putSelected, { payload: desired.selected_actions });
      result.changes.push("applied selected-actions policy");
    }
    if (Object.keys(workflow).length > 0) {
      await call(ctx, this, ENDPOINTS.putWorkflow, { payload: workflow });
      result.changes.push("applied workflow token permissions");
    }
    if (desired.access_level !== undefined) {
      await call(ctx, this, ENDPOINTS.putAccess, {
        payload: { access_level: desired.access_level },
      });
      result.changes.push("applied workflows access level");
    }
    if (desired.artifact_and_log_retention !== undefined) {
      await call(ctx, this, ENDPOINTS.putRetention, {
        payload: desired.artifact_and_log_retention,
        describe: "setting the artifact and log retention window",
      });
      result.changes.push("applied artifact and log retention");
    }
    for (const [key, roles] of Object.entries(CACHE_ENDPOINT_BY_KEY)) {
      if (!(key in cache)) {
        continue;
      }
      await call(ctx, this, ENDPOINTS[roles.put], {
        payload: { [key]: cache[key] },
        describe: `setting the cache ${roles.label} limit`,
      });
      result.changes.push(`applied cache ${roles.label} limit`);
    }
    if (desired.oidc_customization_sub !== undefined) {
      await call(ctx, this, ENDPOINTS.putOidcSub, {
        payload: desired.oidc_customization_sub,
        describe: "customizing the OIDC subject claim",
      });
      result.changes.push("applied the OIDC subject claim template");
    }
    if (desired.fork_pr_contributor_approval !== undefined) {
      await call(ctx, this, ENDPOINTS.putForkPrApproval, {
        payload: desired.fork_pr_contributor_approval,
        describe: "setting the fork PR contributor approval policy",
      });
      result.changes.push("applied the fork PR contributor approval policy");
    }
    if (desired.fork_pr_workflows_private_repos !== undefined) {
      await call(ctx, this, ENDPOINTS.putForkPrPrivate, {
        payload: desired.fork_pr_workflows_private_repos,
        describe: "setting the private-repo fork PR workflow settings",
      });
      result.changes.push("applied the private-repo fork PR workflow settings");
    }
    return result;
  },
};
