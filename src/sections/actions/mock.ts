/**
 * The actions e2e mock fragment (registered in test/e2e/mock/sections.ts). It imports the test-tree
 * seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import {
  asObject,
  noContent,
  ok,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

export const actionsMockHandlers: SectionRestHandlers<"actions"> = {
  "actions.getPermissions": ({ state }) => ok(state.actions_permissions),
  "actions.putPermissions": ({ state, body }) => {
    state.actions_permissions = asObject(body);
    return noContent();
  },
  "actions.getSelected": ({ state }) => {
    // The allowlist applies only under an allowed_actions policy of "selected"; otherwise GitHub
    // answers 409, never a 200 with a stale body.
    if (state.actions_permissions.allowed_actions !== "selected") {
      return { status: 409, body: { message: "The allowed_actions policy is not 'selected'" } };
    }
    return ok(state.selected_actions);
  },
  "actions.putSelected": ({ state, body }) => {
    state.selected_actions = asObject(body);
    return noContent();
  },
  "actions.getWorkflow": ({ state }) => ok(state.workflow_permissions),
  "actions.putWorkflow": ({ state, body }) => {
    state.workflow_permissions = asObject(body);
    return noContent();
  },
  "actions.getAccess": ({ state }) => ok(state.actions_access),
  "actions.putAccess": ({ state, body }) => {
    state.actions_access = asObject(body);
    return noContent();
  },
  "actions.getRetention": ({ state }) => ok(state.actions_retention),
  "actions.putRetention": ({ state, body }) => {
    // The GET shape also carries the read-only maximum_allowed_days, so the {days} body merges instead of replacing.
    state.actions_retention = { ...asObject(state.actions_retention), ...asObject(body) };
    return noContent();
  },
  "actions.getCacheRetention": ({ state }) => ok(state.cache_retention_limit),
  "actions.putCacheRetention": ({ state, body }) => {
    state.cache_retention_limit = asObject(body);
    return noContent();
  },
  "actions.getCacheStorage": ({ state }) => ok(state.cache_storage_limit),
  "actions.putCacheStorage": ({ state, body }) => {
    state.cache_storage_limit = asObject(body);
    return noContent();
  },
  "actions.getOidcSub": ({ state }) => ok(state.oidc_customization_sub),
  "actions.putOidcSub": ({ state, body }) => {
    // 201 with an empty object is the documented success shape. The mock has no organization
    // layer, so an omitted include_claim_keys never resolves to inherited org-template keys the way
    // it does upstream; safe because the section compares only declared keys.
    state.oidc_customization_sub = asObject(body);
    return { status: 201, body: {} };
  },
  "actions.getForkPrApproval": ({ state }) => ok(state.fork_pr_contributor_approval),
  "actions.putForkPrApproval": ({ state, body }) => {
    state.fork_pr_contributor_approval = asObject(body);
    return noContent();
  },
  // Both handlers serve every repository regardless of visibility ON PURPOSE: GitHub documents the
  // pair for private repositories and does not say what a public repository answers (its 403 is
  // bare), so either mock behavior would be a guess, and the engine has no visibility branch on this path.
  "actions.getForkPrPrivate": ({ state }) => ok(state.fork_pr_workflows_private_repos),
  "actions.putForkPrPrivate": ({ state, body }) => {
    // Stored verbatim: the shape requires the complete four-toggle policy, so the mock never models
    // GitHub's UNDOCUMENTED handling of an omitted toggle (preserve vs reset).
    state.fork_pr_workflows_private_repos = asObject(body);
    return noContent();
  },
};
