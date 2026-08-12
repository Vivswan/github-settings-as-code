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
const RESOURCE_LABEL: Record<PatResource, string> = {
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
const RESOURCE_LABEL_ORG: Record<NonNullable<SectionPermission["org"]>, string> = {
  members: "Members",
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
