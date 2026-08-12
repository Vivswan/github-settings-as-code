/**
 * The section's REST endpoint declarations: the single dictionary that
 * drives the request paths, the mock routes, and USED_PATHS - the leaf
 * every sibling module making REST calls reads its routes from.
 */

import type { EndpointDecl } from "../contract/endpoints.js";

/**
 * The 404 on the pattern endpoints is ambiguous: besides a missing grant it
 * can mean the environment does not exist, or that its
 * deployment_branch_policy does not enable custom_branch_policies.
 */
const BRANCH_POLICIES_DENIAL_HINT =
  "a 404 here can also mean the environment does not exist, or that its deployment_branch_policy does not set custom_branch_policies: true";

/**
 * The 404 on the protection-rule endpoints is ambiguous the same way:
 * besides a missing grant it can mean the environment does not exist.
 */
const PROTECTION_RULES_DENIAL_HINT = "a 404 here can also mean the environment does not exist";

export const ENDPOINTS = {
  probe: {
    route: "GET /repos/{owner}/{repo}/environments/{environment_name}",
    statuses: { 200: "the environment", 404: "no such environment yet" },
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
    // Same documented cap as the repository variables list: GitHub clamps
    // a larger per_page, and a clamped page would read as the last one.
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
    // GitHub gates this read under Actions, not Environments (the OIDC
    // customization pair in actions.ts is the precedent for the override).
    permission: { repo: ["actions"] },
    denialHint: BRANCH_POLICIES_DENIAL_HINT,
  },
  createPolicy: {
    route: "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies",
    // GitHub documents 200 for the create (never 201), and 303 when a policy
    // with the same name pattern already exists - desired state is there
    // either way, so the handler treats 303 as converged.
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
  // The protection-rule endpoints spell their path segment with UNDERSCORES
  // (deployment_protection_rules), unlike the hyphenated branch-policy
  // family. GitHub gates them outside the Environments permission too:
  // the enabled-rules list under Actions, everything else under
  // Administration (fine-grained permissions reference).
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
