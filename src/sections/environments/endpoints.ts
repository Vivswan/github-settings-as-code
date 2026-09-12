/**
 * The REST endpoint dictionary, the leaf every sibling module reads its routes and operation
 * types from; it drives the request paths, the mock routes, and USED_PATHS.
 */

import type { EndpointDecl } from "../contract/endpoints.js";
import type { PlanContext, PlannedOp } from "../contract/plan.js";

const BRANCH_POLICIES_DENIAL_HINT =
  "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";

const PROTECTION_RULES_DENIAL_HINT = "a 404 here can also mean the environment does not exist";

export const ENDPOINTS = {
  probe: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}",
    statuses: { 200: "the environment", 404: "no such environment yet" },
    // A fine-grained denial reads as "no such environment" and surfaces on the PUT's 403, so a
    // token that can read nothing still gets an actionable error from the first write.
    primaryRead: { notFound: "absent" },
  },
  update: {
    route: "PUT /repos/{owner}/{repo}/environments/{environment_name}",
    statuses: { 200: "environment created or updated" },
    hints: {
      422: 'Usually "reviewers" entries are not {type: User|Team, id: <numeric id>} (logins and slugs are not accepted), or "deployment_branch_policy" does not declare both boolean keys (or null to clear it)',
    },
  },
  listVariables: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/variables",
    statuses: { 200: "the environment variable list" },
    // GitHub clamps a larger per_page on this list, and a clamped page would read as the last one.
    pageSize: 30,
  },
  createVariable: {
    route: "POST /repos/{owner}/{repo}/environments/{environment_name}/variables",
    statuses: { 201: "environment variable created" },
  },
  updateVariable: {
    route: "PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}",
    statuses: { 204: "environment variable updated" },
  },
  removeVariable: {
    route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}",
    statuses: { 204: "environment variable deleted" },
  },
  listSecrets: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets",
    statuses: { 200: "the environment secrets list (names and timestamps; never values)" },
  },
  secretsPublicKey: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key",
    statuses: { 200: "the environment sealing public key" },
  },
  putSecret: {
    route: "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
    statuses: { 201: "environment secret created", 204: "environment secret updated" },
    alwaysRewrite: true,
  },
  removeSecret: {
    route: "DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
    statuses: { 204: "environment secret deleted" },
  },
  listPolicies: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
    statuses: { 200: "the deployment branch-policy pattern list" },
    // GitHub gates this read under Actions, not Environments.
    permission: { repo: ["actions"] },
    denialHint: BRANCH_POLICIES_DENIAL_HINT,
  },
  createPolicy: {
    route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
    // GitHub documents 200 for the create, never 201; a 303 means the desired state is already
    // there, so it counts as converged.
    statuses: {
      200: "deployment branch policy created",
      303: "a policy with this name pattern already exists",
    },
    permission: { repo: ["administration"] },
    denialHint: BRANCH_POLICIES_DENIAL_HINT,
    hints: {
      422: 'Usually the pattern\'s "type" is not one of the values GitHub accepts ("branch" or "tag"); see the deployment branch policies endpoint documentation',
    },
  },
  removePolicy: {
    route:
      "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}",
    statuses: { 204: "deployment branch policy deleted" },
    permission: { repo: ["administration"] },
    denialHint: BRANCH_POLICIES_DENIAL_HINT,
  },
  // GitHub spells this family's path segment with underscores (deployment_protection_rules), unlike
  // the hyphenated branch-policy family; the permission overrides follow the fine-grained reference.
  listProtectionRules: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules",
    statuses: { 200: "the enabled custom deployment protection rules" },
    permission: { repo: ["actions"] },
    denialHint: PROTECTION_RULES_DENIAL_HINT,
  },
  listProtectionRuleApps: {
    route:
      "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps",
    statuses: { 200: "the protection-rule Apps available to this environment" },
    permission: { repo: ["administration"] },
    denialHint: PROTECTION_RULES_DENIAL_HINT,
  },
  createProtectionRule: {
    route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules",
    statuses: { 201: "custom deployment protection rule enabled" },
    permission: { repo: ["administration"] },
    denialHint: PROTECTION_RULES_DENIAL_HINT,
  },
  removeProtectionRule: {
    route:
      "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}",
    statuses: { 204: "custom deployment protection rule disabled" },
    permission: { repo: ["administration"] },
    denialHint: PROTECTION_RULES_DENIAL_HINT,
  },
} as const satisfies Record<string, EndpointDecl>;

export type EnvironmentsRestContext = PlanContext<typeof ENDPOINTS>;

export type EnvironmentRestOp = PlannedOp<typeof ENDPOINTS>;
