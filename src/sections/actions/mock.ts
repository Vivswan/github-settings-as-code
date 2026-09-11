/**
 * The actions section's e2e mock fragment, registered in
 * test/e2e/mock/sections.ts. Imports the test-tree seams (mock/support.ts)
 * on purpose - the bundle entry is src/main.ts, so this fragment never
 * reaches lib/index.js - and never routes.ts or sections.ts.
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
    // The selected-actions allowlist only applies under an allowed_actions
    // policy of "selected"; otherwise the endpoint answers 409 (its declared
    // "policy is not selected" status), never a 200 with a stale body.
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
    // The PUT body is {days}; the GET shape also carries the read-only
    // maximum_allowed_days, so merge instead of replacing.
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
    // Stores the body verbatim and answers 201 with an empty object (the
    // documented success shape). The mock has no organization layer, so an
    // omitted include_claim_keys never resolves to inherited org-template
    // keys the way it does upstream - a deliberate abstraction, safe
    // because the section compares only declared keys (the unit tests pin
    // that semantic).
    state.oidc_customization_sub = asObject(body);
    return { status: 201, body: {} };
  },
  "actions.getForkPrApproval": ({ state }) => ok(state.fork_pr_contributor_approval),
  "actions.putForkPrApproval": ({ state, body }) => {
    // The PUT body is the same required-approval_policy shape the GET
    // returns, so the body replaces the stored policy wholesale.
    state.fork_pr_contributor_approval = asObject(body);
    return noContent();
  },
  // Both fork-pr-workflows-private-repos handlers serve every repository,
  // visibility included, ON PURPOSE. GitHub documents the pair for private
  // repositories but not what a public repository answers (the contract's
  // 403 is bare), so EITHER mock behavior would be a guess - and the engine
  // has no visibility branch on this path (repo visibility feeds only the
  // redaction machinery), so a visibility-gated denial would exercise no
  // engine code the fine_grained denial scenarios do not already cover.
  // The section's denialHint carries the ambiguity for real users, and the
  // curated scenarios pin the private-repo case.
  "actions.getForkPrPrivate": ({ state }) => ok(state.fork_pr_workflows_private_repos),
  "actions.putForkPrPrivate": ({ state, body }) => {
    // Stored verbatim: the section's shape requires the complete four-toggle
    // policy, so the mock never has to model GitHub's UNDOCUMENTED behavior
    // for an omitted toggle (preserve vs reset), and a complete body makes
    // replace and merge identical anyway.
    state.fork_pr_workflows_private_repos = asObject(body);
    return noContent();
  },
};
