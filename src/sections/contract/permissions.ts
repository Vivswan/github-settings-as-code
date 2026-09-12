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

export interface SectionPermission {
  /** Fine-grained PAT repository permissions; ANY one of these grants access. */
  readonly repo: readonly [PatResource, ...PatResource[]];
  /** Additional organization permission required (teams only). */
  readonly org?: "members";
}

// Declarations are distinct literals, so identity cannot group them: compare as sets.
export function samePermission(
  a: SectionPermission | "none",
  b: SectionPermission | "none",
): boolean {
  if (a === "none" || b === "none") {
    return a === b;
  }
  const resources = new Set(a.repo);
  const others = new Set(b.repo);
  return (
    a.org === b.org &&
    resources.size === others.size &&
    [...resources].every((resource) => others.has(resource))
  );
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

export const RESOURCE_LABEL_ORG: Record<NonNullable<SectionPermission["org"]>, string> = {
  members: "Members",
};

// Each PAT resource's query parameter on GitHub's pre-filled token form (the generated token-form
// link, in this order); total over PatResource, so a new resource names its parameter or records a null exemption.
export const RESOURCE_SLUGS: Record<PatResource, string | null> = {
  // The form drops unknown parameters silently (the old variables= spelling failed that way), so every
  // non-null slug was verified against the live token form on 2026-07-28.
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
  // Verified 2026-08-10 against github/docs src/github-apps/data/fpt-2022-11-28/fine-grained-pat-permissions.json, not the live form.
  agent_secrets: "agent_secrets",
  agent_variables: "agent_variables",
  custom_properties: "repository_custom_properties",
  secret_scanning_alerts: "secret_scanning_alerts",
  contents: "contents",
  // A grant alternative of code_scanning_default_setup; it has no verified token-form parameter today.
  code_scanning_alerts: null,
};

/**
 * `access` defaults to "write" (a section both reads and writes), and a denial on an override endpoint
 * passes overrideAdviceLevel (./errors.ts) so the advice asks for exactly the level the section needs.
 * The output is user-facing: EXPECTED_GRANT in test/sections/registry.test.ts pins every grant character for character.
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
