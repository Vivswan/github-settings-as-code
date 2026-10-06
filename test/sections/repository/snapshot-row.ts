import { repositorySection } from "../../../src/sections/repository/index.js";
import type { Row } from "../snapshot-roundtrip.js";

// Over the repo fixture (ids, urls, counts, owner, license, has_downloads: none PATCHable); the
// overlay adds a null homepage, a passthrough field, two toggles, and the GraphQL fields.
export const row: Row = {
  section: repositorySection,
  live: {
    repo: {
      homepage: null,
      allow_forking: true,
      security_and_analysis: { secret_scanning: { status: "enabled" } },
      vulnerability_alerts_enabled: true,
      immutable_releases_enabled: true,
      has_sponsorships_enabled: true,
      issue_creation_policy: "COLLABORATORS_ONLY",
    },
  },
  expected: {
    value: {
      description: "End-to-end fixture repository for settings-as-code.",
      private: false,
      visibility: "public",
      security_and_analysis: { secret_scanning: { status: "enabled" } },
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      has_discussions: false,
      is_template: false,
      default_branch: "main",
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: true,
      allow_auto_merge: false,
      delete_branch_on_merge: true,
      allow_update_branch: true,
      use_squash_pr_title_as_default: true,
      squash_merge_commit_title: "PR_TITLE",
      squash_merge_commit_message: "PR_BODY",
      merge_commit_title: "MERGE_MESSAGE",
      merge_commit_message: "PR_TITLE",
      archived: false,
      allow_forking: true,
      web_commit_signoff_required: false,
      topics: ["settings-as-code", "automation"],
      enable_vulnerability_alerts: true,
      enable_automated_security_fixes: false,
      enable_private_vulnerability_reporting: false,
      enable_immutable_releases: true,
      enable_sponsorships: true,
      issue_creation_policy: "collaborators_only",
    },
    notes: [
      "repository.enable_git_lfs: GitHub exposes no endpoint to read Git LFS back, so the snapshot leaves it out; declare it yourself to manage it",
    ],
  },
};
