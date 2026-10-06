import type { SectionKey, SettingsFile } from "../../../src/schema.js";
import { endpointMethod } from "../../../src/sections/contract/endpoints.js";
import { allEndpoints, allGraphqlOps } from "../../../src/sections/registry.js";
import type { MustBeNever } from "../../../src/types.js";

/**
 * The one read each section issues in BOTH modes under the batteries' document (SECTION_FAULT_FIXTURE for the key-gated
 * ones), so a fault aimed there fires for certain; UNFAULTABLE_SECTIONS have none.
 */
export const SECTION_PRIMARY_READ = {
  repository: "repository.get",
  labels: "labels.list",
  branches: "branches.getProtection",
  environments: "environments.probe",
  actions: "actions.getWorkflow",
  interaction_limits: "interaction_limits.get",
  rulesets: "rulesets.list",
  autolinks: "autolinks.list",
  workflows: "workflows.list",
  collaborators: "collaborators.list",
  teams: "teams.org",
  milestones: "milestones.list",
  pages: "pages.get",
  code_scanning_default_setup: "code_scanning_default_setup.get",
  code_quality_setup: "code_quality_setup.get",
  actions_variables: "actions_variables.list",
  actions_secrets: "actions_secrets.list",
  dependabot_secrets: "dependabot_secrets.list",
  codespaces_secrets: "codespaces_secrets.list",
  agents_secrets: "agents_secrets.list",
  agents_variables: "agents_variables.list",
  webhooks: "webhooks.list",
  // Runs right after the org probe in both modes; the fault batteries pin owner_kind: "org", so the probe never diverts it.
  custom_properties: "custom_properties.list",
  deploy_keys: "deploy_keys.list",
  secret_scanning_custom_patterns: "secret_scanning_custom_patterns.list",
} as const satisfies Partial<Record<SectionKey, string>>;

export type FaultableSection = keyof typeof SECTION_PRIMARY_READ;

/**
 * The batteries' document for a section whose reads are each gated on a declared key, so its primary read fires for
 * certain; a section absent here reads unconditionally, so its document stays random.
 */
export const SECTION_FAULT_FIXTURE: {
  readonly [K in FaultableSection]?: NonNullable<SettingsFile[K]>;
} = {
  actions: { default_workflow_permissions: "read" },
  // A literal entry: a wildcard-only document reconciles through GraphQL alone.
  branches: [{ name: "main", protection: { enforce_admins: true } }],
  interaction_limits: { limit: "collaborators_only", expiry: "one_week" },
};

/** Sections whose reads all stay COLD in a trigger-avoiding apply (check-only reads, or keys the battery omits); the negative battery proves it. */
export const UNFAULTABLE_SECTIONS = [
  "check_suite_preferences",
] as const satisfies readonly SectionKey[];
export type UnfaultableSection = (typeof UNFAULTABLE_SECTIONS)[number];

type FaultClassified = FaultableSection | UnfaultableSection;
type _UnclassifiedFaultSection = MustBeNever<Exclude<SectionKey, FaultClassified>>;
type _DoublyClassifiedFaultSection = MustBeNever<Extract<FaultableSection, UnfaultableSection>>;

/**
 * MAXIMAL on purpose: each entry declares every key it can without reaching a read, so the battery's claim is "a
 * full-width apply issues no read", not "a tiny apply stays quiet". The battery arms one-shot faults on every GET the
 * section declares (unfaultableReadKeys) and requires none to fire.
 */
export const UNFAULTABLE_APPLY_SETTINGS: {
  [K in UnfaultableSection]: NonNullable<SettingsFile[K]>;
} = {
  // The strongest member: the section declares NO read endpoint, so the battery has nothing to arm and the exemption holds by construction.
  check_suite_preferences: {
    auto_trigger_checks: [{ app_id: 15368, setting: false }],
  },
};

/**
 * Derived from the registry declarations, the same source the mock routes and USED_PATHS derive from, so the battery
 * cannot arm a stale hand-copied key while the section reads somewhere else.
 */
export function unfaultableReadKeys(section: UnfaultableSection): string[] {
  return [
    ...Object.entries(allEndpoints())
      .filter(([key, ep]) => key.startsWith(`${section}.`) && endpointMethod(ep.route) === "GET")
      .map(([key]) => key),
    ...Object.entries(allGraphqlOps())
      .filter(([key, op]) => key.startsWith(`${section}.`) && op.kind === "read")
      .map(([key]) => key),
  ].sort();
}
