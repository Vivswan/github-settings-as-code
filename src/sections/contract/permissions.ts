/** Fine-grained-PAT permission vocabulary and the grant prose derived from it. */

/** A fine-grained-PAT permission resource under Repository permissions. */
export type PatResource =
  | "administration"
  | "issues"
  | "environments"
  | "actions"
  | "pages"
  | "code_scanning_alerts"
  | "contents"
  | "variables"
  | "webhooks"
  | "secrets"
  | "dependabot_secrets"
  | "codespaces_secrets"
  | "custom_properties"
  | "secret_scanning_alerts"
  | "agent_secrets"
  | "agent_variables"
  | "checks";

/**
 * The machine-readable permission a section requires. `repo` lists the
 * fine-grained-PAT Repository permissions where ANY one grants access;
 * `org` names the extra Organization permission a section needs (teams).
 */
export interface SectionPermission {
  /** Fine-grained PAT repository permissions; ANY one of these grants access. */
  readonly repo: readonly [PatResource, ...PatResource[]];
  /** Additional organization permission required (teams only). */
  readonly org?: "members";
}

/** Human-facing label for each PAT resource, as shown in the token UI. */
export const RESOURCE_LABEL: Record<PatResource, string> = {
  administration: "Administration",
  issues: "Issues",
  environments: "Environments",
  actions: "Actions",
  pages: "Pages",
  code_scanning_alerts: "Code scanning alerts",
  contents: "Contents",
  variables: "Variables",
  webhooks: "Webhooks",
  secrets: "Secrets",
  dependabot_secrets: "Dependabot secrets",
  codespaces_secrets: "Codespaces secrets",
  custom_properties: "Custom properties",
  secret_scanning_alerts: "Secret scanning alerts",
  agent_secrets: "Agent secrets",
  agent_variables: "Agent variables",
  checks: "Checks",
};

/** Human-facing label for each PAT organization resource. */
export const RESOURCE_LABEL_ORG: Record<NonNullable<SectionPermission["org"]>, string> = {
  members: "Members",
};

// Each PAT resource's query parameter on GitHub's pre-filled token form (the README link, in this
// order); total over PatResource, so a new resource names its parameter or records a null exemption.
export const RESOURCE_SLUGS: Record<PatResource, string | null> = {
  // The parameter names follow the App-permissions schema where they differ from ours; every
  // non-null slug below was verified against the live token form on 2026-07-28 (each pre-selects
  // its permission; the form drops unknown parameters silently, which is how the old variables= spelling failed).
  administration: "administration",
  issues: "issues",
  environments: "environments",
  pages: "pages",
  actions: "actions",
  variables: "actions_variables",
  webhooks: "repository_hooks",
  checks: "checks",
  secrets: "secrets",
  dependabot_secrets: "dependabot_secrets",
  codespaces_secrets: "codespaces_secrets",
  // The Copilot agents stores. Verified 2026-08-10 against GitHub's
  // machine-readable fine-grained-PAT permission data (github/docs,
  // src/github-apps/data/fpt-2022-11-28/fine-grained-pat-permissions.json),
  // which keys the repository permissions for the /agents/secrets and
  // /agents/variables endpoints as "agent_secrets"/"agent_variables" - the
  // same vocabulary file that carries every form-verified slug above,
  // including the three that differ from our resource names.
  agent_secrets: "agent_secrets",
  agent_variables: "agent_variables",
  custom_properties: "repository_custom_properties",
  secret_scanning_alerts: "secret_scanning_alerts",
  contents: "contents",
  // Rides the repo PATCH's security_and_analysis passthrough for setup;
  // the alerts grant has no verified form parameter today.
  code_scanning_alerts: null,
};

/**
 * Render a SectionPermission into the grant prose used verbatim in
 * permission errors. `caveat`, when given, is appended after "; ". `access`
 * names the level the advice asks for: section grants keep the "write"
 * default (a section both reads and writes), while a denial on an endpoint
 * with its own permission override passes the level the SECTION needs on
 * that permission (overrideAdviceLevel: read unless a sibling endpoint
 * writes with it), so the advice never asks for a broader grant than the
 * section can use - nor a narrower one than it will need next. The default
 * output is user-facing error prose: the EXPECTED_GRANT snapshot in
 * test/sections/registry.test.ts pins every section's grant character for
 * character, and the README's Sections table mirrors those grants.
 */
export function grantFor(
  permission: SectionPermission,
  caveat?: string,
  access: "read" | "write" = "write",
): string {
  const level = access === "read" ? "read" : "read and write";
  const resources = permission.repo.map((resource) => `"${RESOURCE_LABEL[resource]}"`).join(" or ");
  const repoClause = permission.org
    ? `${resources} (${level}) under its Repository permissions`
    : `${resources} (${level}) under the PAT's Repository permissions`;
  const orgClause = permission.org
    ? `"${RESOURCE_LABEL_ORG[permission.org]}" (read) under the PAT's Organization permissions and `
    : "";
  const grant = `grant ${orgClause}${repoClause}`;
  return caveat ? `${grant}; ${caveat}` : grant;
}
