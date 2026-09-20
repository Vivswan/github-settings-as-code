import type { Endpoints } from "@octokit/types";
import { defineVocabularyGap } from "./gap.js";

/**
 * GitHub 422s a repository webhook naming an event it does not deliver to repositories ("is not a valid event"),
 * while the wire type is `string[]`. The values are the events whose Availability on the reference page includes
 * Repositories; an event GitHub adds is a new line here, and until then the parser refuses it naming the page.
 */
export const GAP = defineVocabularyGap({
  reference: "https://docs.github.com/webhooks/webhook-events-and-payloads",
  values: [
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
  ],
});

type WireEvent = NonNullable<
  Endpoints["POST /repos/{owner}/{repo}/hooks"]["parameters"]["events"]
>[number];

/** Fires once @octokit/openapi-types narrows the wire `events` items past `string`: build the enum from that union and delete this file. */
const _deriveTheVocabularyFromOctokitOnceItShipsIt: Exclude<string, WireEvent> extends never
  ? true
  : never = true;
