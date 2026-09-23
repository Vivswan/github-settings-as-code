/**
 * The events GitHub delivers to repository webhooks, spelled as the wire event name: every webhook in GitHub's
 * webhooks OpenAPI description, as @octokit/openapi-webhooks ships it (generated/api.github.com.json), whose
 * supported-webhook-types names "repository". The list is committed, not imported: bundling the descriptor would
 * double lib/index.js. test/sections/webhooks/events.test.ts recomputes it from the package and fails with the
 * names added and dropped when a bump moves the list; the fix is to edit this file to match.
 */

/** GitHub's reference page for the events, the externalDocs url the descriptor's entries point at. */
export const WEBHOOK_EVENTS_REFERENCE =
  "https://docs.github.com/webhooks/webhook-events-and-payloads";

/** Sorted, without the "*" wildcard, which the schema adds. */
export const REPOSITORY_WEBHOOK_EVENTS = [
  "branch_protection_configuration",
  "branch_protection_rule",
  "check_run",
  "check_suite",
  "code_scanning_alert",
  "commit_comment",
  "create",
  "custom_property_values",
  "delete",
  "dependabot_alert",
  "deploy_key",
  "deployment",
  "deployment_status",
  "discussion",
  "discussion_comment",
  "fork",
  "gollum",
  "issue_comment",
  "issue_dependencies",
  "issues",
  "label",
  "member",
  "meta",
  "milestone",
  "package",
  "page_build",
  "ping",
  "project",
  "project_card",
  "project_column",
  "public",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "push",
  "registry_package",
  "release",
  "repository",
  "repository_advisory",
  "repository_import",
  "repository_ruleset",
  "repository_vulnerability_alert",
  "secret_scanning_alert",
  "secret_scanning_alert_location",
  "secret_scanning_scan",
  "security_and_analysis",
  "star",
  "status",
  "sub_issues",
  "team_add",
  "watch",
  "workflow_job",
  "workflow_run",
] as const;
