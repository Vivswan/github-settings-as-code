/**
 * The keys GitHub only reports on an environment entry and on a branch-policy pattern: its GET returns them and
 * the write does not take them. The open shapes in schema.ts still parse one, so a plan names it in a note
 * (../shared/reported-key-note.ts). Each list is pinned both ways to the vendored spec, by its satisfies and its
 * MustBeNever.
 */

import type { components, operations } from "@octokit/openapi-types";
import type { MustBeNever } from "../../types.js";

type EnvironmentPutBody = NonNullable<
  NonNullable<
    operations["repos/create-or-update-environment"]["requestBody"]
  >["content"]["application/json"]
>;

type ReportedEnvironmentKey = Exclude<
  keyof components["schemas"]["environment"],
  keyof EnvironmentPutBody | "name"
>;

/** On an environment entry; `name` addresses the PUT, so it is no reported key. */
export const ENVIRONMENT_REPORTED_KEYS = [
  "id",
  "node_id",
  "url",
  "html_url",
  "created_at",
  "updated_at",
  "protection_rules",
] as const satisfies readonly ReportedEnvironmentKey[];

type _EnvironmentKeysComplete = MustBeNever<
  Exclude<ReportedEnvironmentKey, (typeof ENVIRONMENT_REPORTED_KEYS)[number]>
>;

type ReportedBranchPolicyKey = Exclude<
  keyof components["schemas"]["deployment-branch-policy"],
  keyof components["schemas"]["deployment-branch-policy-name-pattern-with-type"]
>;

/** On a pattern entry, whose only write is the create POST. */
export const BRANCH_POLICY_REPORTED_KEYS = [
  "id",
  "node_id",
] as const satisfies readonly ReportedBranchPolicyKey[];

type _BranchPolicyKeysComplete = MustBeNever<
  Exclude<ReportedBranchPolicyKey, (typeof BRANCH_POLICY_REPORTED_KEYS)[number]>
>;
