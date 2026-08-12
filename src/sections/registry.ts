/**
 * The single registration point for section modules. `byKey` is a mapped
 * type, so the compiler enforces that every SectionKey has a module AND
 * that each module sits under its own key; execution order comes from
 * SECTION_KEYS alone. Adding a section: create sections/<key>.ts exporting
 * a SectionModule, add the key to SECTION_KEYS in schema.ts, and add one
 * line here.
 */

import type { z } from "zod";
import { SECTION_KEYS, type SectionKey } from "../schema.js";
import { actionsSection } from "./actions.js";
import { actionsSecretsSection } from "./actions-secrets.js";
import { actionsVariablesSection } from "./actions-variables.js";
import { agentsSecretsSection } from "./agents-secrets.js";
import { agentsVariablesSection } from "./agents-variables.js";
import { autolinksSection } from "./autolinks.js";
import { branchesSection } from "./branches.js";
import { checkSuitePreferencesSection } from "./check-suite-preferences.js";
import { codeQualitySetupSection } from "./code-quality.js";
import { codeScanningDefaultSetupSection } from "./code-scanning.js";
import { codespacesSecretsSection } from "./codespaces-secrets.js";
import { collaboratorsSection } from "./collaborators.js";
import type { EndpointDecl, GraphqlOpDecl, SectionModule } from "./contract.js";
import { customPropertiesSection } from "./custom-properties.js";
import { dependabotSecretsSection } from "./dependabot-secrets.js";
import { deployKeysSection } from "./deploy-keys.js";
import { environmentsSection } from "./environments.js";
import { interactionLimitsSection } from "./interaction-limits.js";
import { labelsSection } from "./labels/index.js";
import { milestonesSection } from "./milestones.js";
import { pagesSection } from "./pages.js";
import { repositorySection } from "./repository.js";
import { rulesetsSection } from "./rulesets.js";
import { secretScanningPatternsSection } from "./secret-scanning-patterns.js";
import { teamsSection } from "./teams.js";
import { webhooksSection } from "./webhooks.js";
import { workflowsSection } from "./workflows.js";

const byKey: { [K in SectionKey]: SectionModule<K> } = {
  repository: repositorySection,
  labels: labelsSection,
  rulesets: rulesetsSection,
  environments: environmentsSection,
  branches: branchesSection,
  autolinks: autolinksSection,
  actions: actionsSection,
  actions_secrets: actionsSecretsSection,
  dependabot_secrets: dependabotSecretsSection,
  codespaces_secrets: codespacesSecretsSection,
  agents_secrets: agentsSecretsSection,
  workflows: workflowsSection,
  check_suite_preferences: checkSuitePreferencesSection,
  pages: pagesSection,
  code_scanning_default_setup: codeScanningDefaultSetupSection,
  code_quality_setup: codeQualitySetupSection,
  collaborators: collaboratorsSection,
  teams: teamsSection,
  milestones: milestonesSection,
  interaction_limits: interactionLimitsSection,
  actions_variables: actionsVariablesSection,
  agents_variables: agentsVariablesSection,
  webhooks: webhooksSection,
  custom_properties: customPropertiesSection,
  deploy_keys: deployKeysSection,
  secret_scanning_custom_patterns: secretScanningPatternsSection,
};

/** Every section module, in execution order. */
export const SECTIONS: readonly SectionModule[] = SECTION_KEYS.map((key) => byKey[key]);

/** The loose shape validation accepts for a section's declared value. */
export function sectionShape(key: SectionKey): z.ZodType {
  return byKey[key].shape;
}

/** The section module for a key (validate.ts reads shape + closedSurface). */
export function sectionModule<K extends SectionKey>(key: K): SectionModule<K> {
  return byKey[key];
}

/** One endpoint in the flattened cross-section view, tagged with its owner. */
export type TaggedEndpoint = EndpointDecl & {
  readonly section: SectionKey;
  readonly role: string;
};

/**
 * Every section's endpoints flattened into one dictionary keyed
 * `${sectionKey}.${role}` ("labels.update", "teams.org", ...). Keys are
 * globally unique by construction (section key + local role). This is the
 * merge-ready single view downstream consumers (the e2e mock's route table,
 * USED_PATHS derivation) iterate, without renaming any section's local roles.
 *
 * The returned record, each tagged entry, and the nested statuses/permission
 * objects are frozen: they are (or reference) the section declarations, which
 * must never mutate at runtime, so a consumer cannot corrupt the source
 * dictionaries through this view.
 */
export function allEndpoints(): Readonly<Record<string, TaggedEndpoint>> {
  const out: Record<string, TaggedEndpoint> = {};
  for (const section of SECTIONS) {
    for (const [role, endpoint] of Object.entries(section.endpoints)) {
      Object.freeze(endpoint.statuses);
      if (endpoint.permission && typeof endpoint.permission === "object") {
        Object.freeze(endpoint.permission);
        Object.freeze(endpoint.permission.repo);
      }
      out[`${section.key}.${role}`] = Object.freeze({ ...endpoint, section: section.key, role });
    }
  }
  return Object.freeze(out);
}

/** One GraphQL operation in the flattened cross-section view, tagged with its owner. */
export type TaggedGraphqlOp = GraphqlOpDecl & {
  readonly section: SectionKey;
  readonly role: string;
};

/**
 * Every section's GraphQL operations flattened into one dictionary keyed
 * `${sectionKey}.${role}`, the allEndpoints() sibling the e2e mock's dispatch
 * table, the coverage tripwire, and the fault-key universe iterate. Frozen
 * for the same reason: the declarations must never mutate at runtime.
 *
 * Two shapes are asserted here, at construction, because the rest of the
 * system depends on them:
 *   - operation NAMES are globally unique: the name is the wire dispatch key
 *     (the operationName on every request), so a duplicate would make the
 *     mock's dispatch and the coverage attribution ambiguous;
 *   - a role never collides with a REST endpoint role in the same section:
 *     fault/corruption directives address both dictionaries through one
 *     "section.role" key space.
 * A declared `connection`'s cursor contract needs no assert here: the
 * GraphqlPaginatedReadDecl query type makes a paginated operation that
 * cannot page uncompilable at its declaration.
 * `sections` is injectable so the asserts are directly testable; production
 * callers take the registry default.
 */
export function allGraphqlOps(
  sections: ReadonlyArray<Pick<SectionModule, "key" | "endpoints" | "graphql">> = SECTIONS,
): Readonly<Record<string, TaggedGraphqlOp>> {
  const out: Record<string, TaggedGraphqlOp> = {};
  const byName = new Map<string, string>();
  for (const section of sections) {
    for (const [role, op] of Object.entries(section.graphql ?? {})) {
      const key = `${section.key}.${role}`;
      if (section.endpoints[role] !== undefined) {
        throw new Error(
          `BUG: section "${section.key}" declares both a REST endpoint and a GraphQL operation under the role "${role}"; fault and corruption directives share the "section.role" key space, so roles must be distinct`,
        );
      }
      const holder = byName.get(op.name);
      if (holder !== undefined) {
        throw new Error(
          `BUG: GraphQL operation name "${op.name}" is declared by both ${holder} and ${key}; operation names are the wire dispatch key and must be globally unique`,
        );
      }
      byName.set(op.name, key);
      Object.freeze(op.outcomes);
      if (op.permission && typeof op.permission === "object") {
        Object.freeze(op.permission);
        Object.freeze(op.permission.repo);
      }
      out[key] = Object.freeze({ ...op, section: section.key, role });
    }
  }
  return Object.freeze(out);
}
