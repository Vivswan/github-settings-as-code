/**
 * The actions fuzz generator fragment, aggregated by test/e2e/generators.ts. It imports only the
 * test-tree leaf seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

export function genActions(rng: Rng): Json {
  // oidc_customization_sub is NEVER generated here: its endpoints carry a per-endpoint permission
  // override (Actions, not Administration) that the oracle's section-level permission model cannot
  // grade, so a masked iteration declaring it would mispredict. The actions-oidc-* scenarios cover it.
  const actions: Json = {};
  if (rng.bool()) {
    actions.default_workflow_permissions = rng.pick(["read", "write"]);
  }
  if (rng.bool()) {
    actions.can_approve_pull_request_reviews = rng.bool();
  }
  // Coupling: selected_actions only applies under allowed_actions "selected".
  if (rng.bool(0.5)) {
    actions.allowed_actions = "selected";
    actions.selected_actions = {
      github_owned_allowed: rng.bool(),
      verified_allowed: rng.bool(),
      patterns_allowed: [`${rng.pick(["actions", "octo"])}/*`],
    };
  } else if (rng.bool()) {
    actions.allowed_actions = rng.pick(["all", "local_only"]);
  }
  if (rng.bool(0.3)) {
    actions.access_level = rng.pick(["none", "user", "organization"]);
  }
  if (rng.bool(0.3)) {
    actions.artifact_and_log_retention = { days: rng.int(400) + 1 };
  }
  if (rng.bool(0.3)) {
    const cache: Json = {};
    if (rng.bool()) {
      cache.max_cache_retention_days = rng.int(14) + 1;
    }
    if (rng.bool() || Object.keys(cache).length === 0) {
      cache.max_cache_size_gb = rng.int(50) + 1;
    }
    actions.cache = cache;
  }
  if (Object.keys(actions).length === 0) {
    actions.default_workflow_permissions = rng.pick(["read", "write"]);
  }
  // The fork PR keys are later draws on their own forked streams, so pre-existing seeds keep
  // producing the same document above.
  const approvalRng = rng.fork("fork-pr-approval");
  if (approvalRng.bool(0.3)) {
    actions.fork_pr_contributor_approval = {
      approval_policy: approvalRng.pick([
        "first_time_contributors_new_to_github",
        "first_time_contributors",
        "all_external_contributors",
      ]),
    };
  }
  const privateReposRng = rng.fork("fork-pr-private");
  if (privateReposRng.bool(0.3)) {
    // The shape requires the COMPLETE policy (GitHub does not document whether the PUT preserves
    // an omitted toggle), so every draw carries all four booleans.
    actions.fork_pr_workflows_private_repos = {
      run_workflows_from_fork_pull_requests: privateReposRng.bool(),
      send_write_tokens_to_workflows: privateReposRng.bool(),
      send_secrets_and_variables: privateReposRng.bool(),
      require_approval_for_fork_pr_workflows: privateReposRng.bool(),
    };
  }
  return actions;
}
