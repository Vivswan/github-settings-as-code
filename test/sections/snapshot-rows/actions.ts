import { actionsSection } from "../../../src/sections/actions/index.js";
import type { Row } from "../snapshot-roundtrip.js";

// The unseeded endpoints answer the mock's GitHub-default bodies, which read back too.
export const row: Row = {
  section: actionsSection,
  live: {
    actions_permissions: {
      enabled: true,
      allowed_actions: "selected",
      selected_actions_url: "https://api.github.com/repos/o/r/actions/permissions/selected-actions",
    },
    selected_actions: {
      github_owned_allowed: true,
      verified_allowed: true,
      patterns_allowed: ["docker/*"],
    },
    workflow_permissions: {
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: true,
    },
    actions_access: { access_level: "user" },
    actions_retention: { days: 14, maximum_allowed_days: 400 },
  },
  expected: {
    value: {
      enabled: true,
      allowed_actions: "selected",
      default_workflow_permissions: "write",
      can_approve_pull_request_reviews: true,
      selected_actions: {
        github_owned_allowed: true,
        verified_allowed: true,
        patterns_allowed: ["docker/*"],
      },
      access_level: "user",
      artifact_and_log_retention: { days: 14 },
      cache: { max_cache_retention_days: 7, max_cache_size_gb: 10 },
      oidc_customization_sub: { use_default: true },
      fork_pr_contributor_approval: { approval_policy: "first_time_contributors_new_to_github" },
      fork_pr_workflows_private_repos: {
        run_workflows_from_fork_pull_requests: false,
        send_write_tokens_to_workflows: false,
        send_secrets_and_variables: false,
        require_approval_for_fork_pr_workflows: true,
      },
    },
    notes: [],
  },
};
