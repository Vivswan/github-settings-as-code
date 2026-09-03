/**
 * The single registration point for section modules. `byKey` is checked
 * against a mapped type, so the compiler enforces that every SectionKey has
 * a module AND that each module sits under its own key, while `satisfies`
 * keeps each module's LITERAL type - its exact endpoint and GraphQL role
 * names - for the key unions derived below; execution order comes from
 * SECTION_KEYS alone. Adding a section: create sections/<key>/ exporting
 * a SectionModule, add the key to SECTION_KEYS in schema.ts, and add one
 * line here.
 */

import type { z } from "zod";
import { SECTION_KEYS, type SectionKey, type SettingsFile } from "../schema.js";
import type { MustBeNever } from "../types.js";
import { actionsSection } from "./actions/index.js";
import { actionsSecretsSection } from "./actions_secrets/index.js";
import { actionsVariablesSection } from "./actions_variables/index.js";
import { agentsSecretsSection } from "./agents_secrets/index.js";
import { agentsVariablesSection } from "./agents_variables/index.js";
import { autolinksSection } from "./autolinks/index.js";
import { branchesSection } from "./branches/index.js";
import { checkSuitePreferencesSection } from "./check_suite_preferences/index.js";
import { codeQualitySetupSection } from "./code_quality_setup/index.js";
import { codeScanningDefaultSetupSection } from "./code_scanning_default_setup/index.js";
import { codespacesSecretsSection } from "./codespaces_secrets/index.js";
import { collaboratorsSection } from "./collaborators/index.js";
import type { EndpointDecl } from "./contract/endpoints.js";
import type { GraphqlOpDecl } from "./contract/graphql.js";
import type { EndpointDict, GraphqlDict, SectionModule } from "./contract/module.js";
import type { PlanContext } from "./contract/plan.js";
import { customPropertiesSection } from "./custom_properties/index.js";
import { dependabotSecretsSection } from "./dependabot_secrets/index.js";
import { deployKeysSection } from "./deploy_keys/index.js";
import { environmentsSection } from "./environments/index.js";
import { interactionLimitsSection } from "./interaction_limits/index.js";
import { labelsSection } from "./labels/index.js";
import { milestonesSection } from "./milestones/index.js";
import { pagesSection } from "./pages/index.js";
import { repositorySection } from "./repository/index.js";
import { rulesetsSection } from "./rulesets/index.js";
import { secretScanningPatternsSection } from "./secret_scanning_custom_patterns/index.js";
import { teamsSection } from "./teams/index.js";
import { webhooksSection } from "./webhooks/index.js";
import { workflowsSection } from "./workflows/index.js";

const byKey = {
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
} satisfies { [K in SectionKey]: SectionModule<K> };

/** Each section's module with its literal endpoint/GraphQL dictionaries. */
type SectionModules = typeof byKey;

/**
 * The declarations a module's plan() was TYPED over - the two dictionaries behind its context plus
 * its declared-value parameter. Read off the handler signature, not the module's own declarations,
 * so the two can be compared.
 */
type PlanTypedOver<M> = M extends {
  plan: (ctx: PlanContext<infer E, infer G>, desired: infer D) => unknown;
}
  ? { endpoints: E; graphql: G; desired: D }
  : never;

/**
 * What a module's plan() MUST be typed over, derived from what the module
 * actually declares: its own endpoint dictionary, its own GraphQL
 * dictionary (the SectionModule default when it declares none, which is
 * what `SectionModule<"key", typeof ENDPOINTS>` supplies), and its own
 * section's declared value.
 */
type ExpectedPlanDeclarations<K extends SectionKey, M> = {
  endpoints: M extends { endpoints: infer E extends EndpointDict } ? E : never;
  graphql: M extends { graphql: infer G extends GraphqlDict } ? G : GraphqlDict;
  desired: Exclude<SettingsFile[K], undefined>;
};

/** Mutual assignability - equality up to structure, in both directions. */
type Invariant<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Plan modules whose handler was typed over anything but its own
 * declarations. Comparing the dictionaries as PROPERTIES is what makes the
 * comparison strict: reaching them through the context itself would compare
 * the bound read helpers, whose METHOD parameters TypeScript checks
 * bivariantly, so a wider endpoint dictionary (roles erased to strings), a
 * phantom role planContext never binds (undefined at runtime), a widened
 * GraphQL variables shape, or a narrowed declared value would all measure
 * as equal.
 */
/**
 * `K` when module `M`'s plan() is typed over anything but its own declarations, never when it is
 * exact. Exported for its negative control (test/sections/registry.test.ts).
 */
export type MisdeclaredPlanModule<K extends SectionKey, M> =
  Invariant<PlanTypedOver<M>, ExpectedPlanDeclarations<K, M>> extends true ? never : K;

type MisdeclaredPlanModules = {
  [K in SectionKey]: MisdeclaredPlanModule<K, SectionModules[K]>;
}[SectionKey];

/**
 * Compile-time lockstep: a plan section whose handler is typed over
 * anything but its own literal dictionaries and declared value (the shape
 * `satisfies SectionModule<"key", typeof ENDPOINTS>` produces) fails here,
 * naming itself, instead of losing role checking silently.
 */
type _PlanModulesAreExact = MustBeNever<MisdeclaredPlanModules>;

/**
 * The `${section}.${role}` key union for REST endpoints - per section, or
 * across all sections by default. Derived from each module's literal
 * ENDPOINTS type, so this union (and every consumer: the mock handler
 * tables, dispatch, fault directives) tracks the declarations by
 * construction; a key naming no declared endpoint does not compile.
 */
export type SectionEndpointKey<K extends SectionKey = SectionKey> = {
  [S in SectionKey]: `${S}.${keyof SectionModules[S]["endpoints"] & string}`;
}[K];

/**
 * The `${section}.${role}` key union for GraphQL operations, the
 * SectionEndpointKey sibling. A module without a `graphql` dictionary
 * contributes nothing (never), so the union spans exactly the declaring
 * sections.
 */
export type SectionGraphqlKey<K extends SectionKey = SectionKey> = {
  [S in SectionKey]: SectionModules[S] extends { readonly graphql: infer G }
    ? `${S}.${keyof G & string}`
    : never;
}[K];

/**
 * The same registry under per-key SectionModule<K> types: the erased view
 * SECTIONS and sectionModule() serve. Erasure must go through THIS mapped
 * annotation (not straight from the literal types) because the compiler
 * relates SectionModule<K> to SectionModule<SectionKey> by variance, while
 * a literal module's closedSurface would be compared structurally against
 * the union-collapsed (never-keyed) wide form and rejected.
 */
const byKeyErased: { [K in SectionKey]: SectionModule<K> } = byKey;

/** Every section module, in execution order. */
export const SECTIONS: readonly SectionModule[] = SECTION_KEYS.map((key) => byKeyErased[key]);

/** The loose shape validation accepts for a section's declared value. */
export function sectionShape(key: SectionKey): z.ZodType {
  return byKey[key].shape;
}

/** The section module for a key (validate.ts reads shape + closedSurface). */
export function sectionModule<K extends SectionKey>(key: K): SectionModule<K> {
  return byKeyErased[key];
}

/** One endpoint in the flattened cross-section view, tagged with its owner. */
export type TaggedEndpoint = EndpointDecl & {
  readonly section: SectionKey;
  readonly role: string;
};

/**
 * Construction-time guard on the "section.role" key space: ":" is RESERVED
 * for a future scope prefix ("<scope>:<section>.<role>", where a scope could
 * qualify a key by owner or ring), so no bare section key or role may
 * contain it - a colon smuggled in today would be indistinguishable from a
 * scoped key later. Both flattened views call this on every entry.
 */
function assertScopeFree(kind: "section key" | "role", value: string): void {
  if (value.includes(":")) {
    throw new Error(
      `BUG: ${kind} "${value}" contains ":", which the "section.role" key space reserves for a future scope prefix ("<scope>:<section>.<role>"); rename it without a colon`,
    );
  }
}

/**
 * Every section's endpoints flattened into one dictionary keyed
 * `${sectionKey}.${role}` ("labels.update", "teams.org", ...). Keys are
 * globally unique by construction (section key + local role), and the
 * record is keyed by the exact SectionEndpointKey union, so a consumer
 * looking up a key no section declares does not compile. This is the
 * merge-ready single view downstream consumers (the e2e mock's route table,
 * USED_PATHS derivation) iterate, without renaming any section's local roles.
 *
 * The returned record, each tagged entry, and the nested statuses/permission
 * objects are frozen: they are (or reference) the section declarations, which
 * must never mutate at runtime, so a consumer cannot corrupt the source
 * dictionaries through this view.
 *
 * `sections` is injectable so the scope-free assert is directly testable;
 * production callers take the registry default, whose record is keyed by
 * the exact SectionEndpointKey union (an injected synthetic list keeps
 * string keys) - the allGraphqlOps overload shape.
 */
export function allEndpoints(): Readonly<Record<SectionEndpointKey, TaggedEndpoint>>;
export function allEndpoints(
  sections: ReadonlyArray<Pick<SectionModule, "key" | "endpoints">>,
): Readonly<Record<string, TaggedEndpoint>>;
export function allEndpoints(
  sections: ReadonlyArray<Pick<SectionModule, "key" | "endpoints">> = SECTIONS,
): Readonly<Record<string, TaggedEndpoint>> {
  const out: Record<string, TaggedEndpoint> = {};
  for (const section of sections) {
    assertScopeFree("section key", section.key);
    for (const [role, endpoint] of Object.entries(section.endpoints)) {
      assertScopeFree("role", role);
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
 * callers take the registry default, whose record is keyed by the exact
 * SectionGraphqlKey union (an injected synthetic list keeps string keys).
 */
export function allGraphqlOps(): Readonly<Record<SectionGraphqlKey, TaggedGraphqlOp>>;
export function allGraphqlOps(
  sections: ReadonlyArray<Pick<SectionModule, "key" | "endpoints" | "graphql">>,
): Readonly<Record<string, TaggedGraphqlOp>>;
export function allGraphqlOps(
  sections: ReadonlyArray<Pick<SectionModule, "key" | "endpoints" | "graphql">> = SECTIONS,
): Readonly<Record<string, TaggedGraphqlOp>> {
  const out: Record<string, TaggedGraphqlOp> = {};
  const byName = new Map<string, string>();
  for (const section of sections) {
    assertScopeFree("section key", section.key);
    for (const [role, op] of Object.entries(section.graphql ?? {})) {
      assertScopeFree("role", role);
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
