import { branchesSection } from "../../../src/sections/branches/index.js";
import type { Row } from "../snapshot-roundtrip.js";

// The GET shape: url keys, {enabled} wrappers, actor objects, the checks list spelled twice.
export const row: Row = {
  section: branchesSection,
  live: {
    branches: ["main", "develop"],
    branch_protection: {
      main: {
        url: "https://api.github.com/repos/o/r/branches/main/protection",
        required_status_checks: {
          url: "https://api.github.com/x/required_status_checks",
          strict: true,
          contexts: ["ci"],
          contexts_url: "https://api.github.com/x/required_status_checks/contexts",
          checks: [{ context: "ci", app_id: null }],
          enforcement_level: "non_admins",
        },
        enforce_admins: { url: "https://api.github.com/x/enforce_admins", enabled: true },
        required_pull_request_reviews: {
          url: "https://api.github.com/x/required_pull_request_reviews",
          dismiss_stale_reviews: true,
          require_code_owner_reviews: false,
          required_approving_review_count: 2,
          require_last_push_approval: false,
          dismissal_restrictions: {
            url: "https://api.github.com/x/dismissal_restrictions",
            users_url: "https://api.github.com/x/dismissal_restrictions/users",
            teams_url: "https://api.github.com/x/dismissal_restrictions/teams",
            users: [{ login: "octocat", id: 1 }],
            teams: [{ slug: "platform", id: 2 }],
            apps: [],
          },
        },
        restrictions: {
          url: "https://api.github.com/x/restrictions",
          users_url: "https://api.github.com/x/restrictions/users",
          teams_url: "https://api.github.com/x/restrictions/teams",
          apps_url: "https://api.github.com/x/restrictions/apps",
          users: [{ login: "release-bot", id: 3 }],
          teams: [],
          apps: [{ slug: "deploy-gate", id: 4 }],
        },
        required_linear_history: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        block_creations: { enabled: false },
        required_conversation_resolution: { enabled: false },
        lock_branch: { enabled: false },
        allow_fork_syncing: { enabled: false },
        required_signatures: {
          url: "https://api.github.com/x/required_signatures",
          enabled: true,
        },
      },
      develop: null,
    },
  },
  expected: {
    value: [
      {
        name: "main",
        protection: {
          required_status_checks: {
            strict: true,
            contexts: ["ci"],
            checks: [{ context: "ci", app_id: -1 }],
          },
          enforce_admins: true,
          required_pull_request_reviews: {
            dismiss_stale_reviews: true,
            require_code_owner_reviews: false,
            required_approving_review_count: 2,
            require_last_push_approval: false,
            dismissal_restrictions: { users: ["octocat"], teams: ["platform"], apps: [] },
          },
          restrictions: { users: ["release-bot"], teams: [], apps: ["deploy-gate"] },
          required_linear_history: true,
          required_signatures: true,
        },
      },
    ],
    notes: [
      "protection.force_push_bypassers, protection.required_deployments, and wildcard rules ride the GraphQL rule " +
        "surface, which snapshot does not read; an omitted key leaves its live value untouched, so declare them to " +
        "manage them. A branch a wildcard rule protects is written here as a LITERAL entry carrying that rule's " +
        "protection (the REST reads name no pattern), and applying it would create a literal rule beside the " +
        "wildcard; replace such entries with one wildcard entry naming the pattern",
    ],
  },
};
