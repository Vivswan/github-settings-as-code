/**
 * `byKey` is checked against a mapped type (every SectionKey has a module, under its own key) while
 * `satisfies` keeps each module's LITERAL type for the key unions derived below; execution order comes
 * from SECTION_KEYS alone.
 *
 *   adding a section: create sections/<key>/ -> add the key to SECTION_KEYS in schema.ts -> add one line here
 */

import type { z } from "zod";
import { type ListSection, SECTION_KEYS, type SectionKey } from "../schema.js";
import type { DeepReadonly, MustBeNever } from "../types.js";
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
import {
  type DeclaresRead,
  deepFreeze,
  type EndpointDict,
  freezeDeclarations,
  type GraphqlDict,
  type KeyedListLayering,
  type ORG_PROBE,
  type SectionModule,
  type ValidatedInput,
} from "./contract/module.js";
import { gatedByOwner } from "./contract/owner.js";
import type { PlanContext, SnapshotContext } from "./contract/plan.js";
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

type SectionModules = typeof byKey;

/** Read off the handler signature, not the module's own declarations, so the two can be compared. */
type PlanTypedOver<M> = M extends {
  plan: (ctx: PlanContext<infer E, infer G, infer K>, desired: infer D) => unknown;
}
  ? { key: K; endpoints: E; graphql: G; desired: D }
  : never;

/** The GraphQL arm defaults to GraphqlDict when the module declares none, which is what `SectionModule<"key", typeof ENDPOINTS>` supplies. */
type ExpectedPlanDeclarations<K extends SectionKey, M> = {
  key: K;
  endpoints: M extends { endpoints: infer E extends EndpointDict } ? E : never;
  graphql: M extends { graphql: infer G extends GraphqlDict } ? G : GraphqlDict;
  desired: ValidatedInput<K>;
};

type Invariant<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compares the dictionaries as PROPERTIES: reaching them through the context would compare the bound read
 * helpers, whose METHOD parameters TypeScript checks bivariantly, so a wider dictionary, a phantom role, a
 * widened variables shape, or a narrowed declared value would all measure as equal. Exported for its
 * negative control (test/sections/registry.test.ts).
 */
export type MisdeclaredPlanModule<K extends SectionKey, M> =
  Invariant<PlanTypedOver<M>, ExpectedPlanDeclarations<K, M>> extends true ? never : K;

type MisdeclaredPlanModules = {
  [K in SectionKey]: MisdeclaredPlanModule<K, SectionModules[K]>;
}[SectionKey];

/**
 * A plan typed over anything but its own key, literal dictionaries, and declared value fails here
 * naming itself, instead of losing role checking silently.
 */
type _PlanModulesAreExact = MustBeNever<MisdeclaredPlanModules>;

/** The key and dictionaries a module's snapshot() was TYPED over, or "absent" when it declares none. */
type SnapshotTypedOver<M> = M extends {
  snapshot: (ctx: SnapshotContext<infer E, infer G, infer K>) => unknown;
}
  ? { key: K; endpoints: E; graphql: G }
  : "absent";

/**
 * `K` when module `M`'s snapshot() is typed over anything but its own dictionaries, never when it
 * is exact or absent: the MisdeclaredPlanModule sibling for the read-back handler.
 */
export type MisdeclaredSnapshotModule<K extends SectionKey, M> =
  SnapshotTypedOver<M> extends "absent"
    ? never
    : Invariant<SnapshotTypedOver<M>, Omit<ExpectedPlanDeclarations<K, M>, "desired">> extends true
      ? never
      : K;

type MisdeclaredSnapshotModules = {
  [K in SectionKey]: MisdeclaredSnapshotModule<K, SectionModules[K]>;
}[SectionKey];

/** Compile-time lockstep: a snapshot() over another section's dictionaries fails here by name. */
type _SnapshotModulesAreExact = MustBeNever<MisdeclaredSnapshotModules>;

/**
 * `K` when module `M` declares a read (a GET or a GraphQL read) but no snapshot(). SnapshotFacet
 * (contract/module.ts) measures this only on a module annotated over its literal dictionaries, and the
 * factories' modules arrive under their own interfaces, so the door measures every registrant.
 */
export type ReadingModuleWithoutSnapshot<K extends SectionKey, M> =
  SnapshotTypedOver<M> extends "absent"
    ? DeclaresRead<
        ExpectedPlanDeclarations<K, M>["endpoints"],
        ExpectedPlanDeclarations<K, M>["graphql"]
      > extends true
      ? K
      : never
    : never;

type ReadingModulesWithoutSnapshot = {
  [K in SectionKey]: ReadingModuleWithoutSnapshot<K, SectionModules[K]>;
}[SectionKey];

/** A reading section registered without snapshot() fails here by name; only a write-only section may lack one. */
type _ReadingModulesSnapshot = MustBeNever<ReadingModulesWithoutSnapshot>;

/**
 * A module flagged `ownerSensitivity: "org"` without the owner probe under its `org` role fails here by
 * name: the owner gate (contract/owner.ts) reads that role, so the flag alone would promise a no-op the
 * gate cannot perform.
 */
type OwnerGatesWithoutProbe = {
  [K in SectionKey]: SectionModules[K] extends { readonly ownerSensitivity: "org" }
    ? SectionModules[K]["endpoints"] extends {
        readonly org: { readonly route: typeof ORG_PROBE.route };
      }
      ? never
      : K
    : never;
}[SectionKey];

type _OwnerGatesDeclareTheProbe = MustBeNever<OwnerGatesWithoutProbe>;

/**
 * Every list section layers by key, so a list module registered without `layering` fails here by name:
 * the fold would otherwise have no key to union its entries by and would replace them silently.
 */
type ListModulesWithoutKey = {
  [K in ListSection]: SectionModules[K] extends { readonly layering: KeyedListLayering }
    ? never
    : K;
}[ListSection];

type _ListModulesDeclareTheirKey = MustBeNever<ListModulesWithoutKey>;

/**
 * Derived from each module's literal ENDPOINTS, so every consumer (the mock handler tables, dispatch,
 * fault directives) tracks the declarations by construction.
 */
export type SectionEndpointKey<K extends SectionKey = SectionKey> = {
  [S in SectionKey]: `${S}.${keyof SectionModules[S]["endpoints"] & string}`;
}[K];

export type SectionGraphqlKey<K extends SectionKey = SectionKey> = {
  [S in SectionKey]: SectionModules[S] extends { readonly graphql: infer G }
    ? `${S}.${keyof G & string}`
    : never;
}[K];

/**
 * Erasure must go through THIS mapped annotation: the compiler relates SectionModule<K> to
 * SectionModule<SectionKey> by variance, while a literal module's closedSurface compared structurally
 * against the union-collapsed wide form would be rejected.
 */
const byKeyErased: { [K in SectionKey]: SectionModule<K> } = byKey;

/**
 * The runtime twin of PlanContext's key brand, for a JavaScript consumer and the erased roster (SECTIONS
 * is homogeneous, so the brand cannot tell two of its members apart): a handler given another section's
 * context would otherwise fail on its first read with an undefined port. A rejection, not a throw, so
 * the handler's promise contract holds for a consumer's `.catch()`. Each arm calls the module's own
 * property at call time: handlers read `this`, and a test stubs the module while the engine holds this.
 */
function refusingForeignContexts<K extends SectionKey>(module: SectionModule<K>): SectionModule<K> {
  const refusal = (ctx: PlanContext, handler: "plan" | "snapshot"): Error | null =>
    ctx.section === module.key
      ? null
      : new Error(
          `${module.key}.${handler}() was given the context built for section "${ctx.section}"; build it from this module: ` +
            `${handler}Context(sectionModule("${module.key}"), api, repo${handler === "plan" ? "" : ", onMissingPermission"})`,
        );
  return {
    ...module,
    plan: (ctx, desired) => {
      const error = refusal(ctx, "plan");
      return error === null ? module.plan(ctx, desired) : Promise.reject(error);
    },
    ...(hasSnapshot(module)
      ? {
          snapshot: (ctx: SnapshotContext<EndpointDict, GraphqlDict, K>) => {
            const error = refusal(ctx, "snapshot");
            return error === null ? module.snapshot(ctx) : Promise.reject(error);
          },
        }
      : {}),
  };
}

function hasSnapshot<K extends SectionKey>(
  module: SectionModule<K>,
): module is SectionModule<K> & { snapshot: NonNullable<SectionModule<K>["snapshot"]> } {
  return module.snapshot !== undefined;
}

/**
 * The one door out of src/sections: the engine, the library, and the roster below all reach a module
 * through it, so the owner gate (contract/owner.ts) and the foreign-context refusal are applied here once
 * and not in 26 handlers, and so is the freeze (freezeDeclarations): the wrapper shares its declaration
 * objects with the source module, so those are deep-frozen in place, while only the wrapper object is
 * shallow-frozen (a test can still stub the source's handlers). The freeze lives here rather than in a
 * definition helper because the modules arrive by several routes (literal objects, listSection, the
 * secrets, variables, and setup factories).
 */
const guarded: { [K in SectionKey]: SectionModule<K> } = Object.fromEntries(
  SECTION_KEYS.map((key) => [
    key,
    freezeDeclarations(refusingForeignContexts(gatedByOwner(byKeyErased[key]))),
  ]),
) as { [K in SectionKey]: SectionModule<K> };

export const SECTIONS: readonly SectionModule[] = SECTION_KEYS.map((key) => guarded[key]);

export function sectionShape(key: SectionKey): z.ZodType {
  return byKey[key].shape;
}

/** The section module for a key (validate.ts reads shape + closedSurface). */
export function sectionModule<K extends SectionKey>(key: K): SectionModule<K> {
  return guarded[key];
}

/** The key a list section's entries layer by; total because the registry requires the declaration (_ListModulesDeclareTheirKey). */
export function listLayering(key: ListSection): KeyedListLayering {
  const module: { readonly layering: KeyedListLayering } = byKey[key];
  return module.layering;
}

export type TaggedEndpoint = DeepReadonly<
  EndpointDecl & {
    readonly section: SectionKey;
    readonly role: string;
  }
>;

/**
 * ":" is RESERVED for a future scope prefix ("<scope>:<section>.<role>"); a colon smuggled in today
 * would be indistinguishable from a scoped key later.
 */
function assertScopeFree(kind: "section key" | "role", value: string): void {
  if (value.includes(":")) {
    throw new Error(
      `BUG: ${kind} "${value}" contains ":", which the "section.role" key space reserves for a future scope prefix ("<scope>:<section>.<role>"); rename it without a colon`,
    );
  }
}

/**
 * The single view the e2e mock's route table and USED_PATHS iterate, keyed by the exact SectionEndpointKey
 * union so an undeclared lookup does not compile. The tagged entries are deep-frozen as they are built;
 * their source declarations were frozen at registration. `sections` is injectable so the scope-free
 * assert is testable; an injected list keeps string keys.
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
      out[`${section.key}.${role}`] = deepFreeze({ ...endpoint, section: section.key, role });
    }
  }
  return Object.freeze(out);
}

export type TaggedGraphqlOp = DeepReadonly<
  GraphqlOpDecl & {
    readonly section: SectionKey;
    readonly role: string;
  }
>;

/**
 * The allEndpoints() sibling for the mock's dispatch table, the coverage tripwire, and the fault-key
 * universe; frozen the same way. Operation NAMES must be globally unique (the wire dispatch key),
 * and a role never collides with a REST role in the same section (fault directives share one "section.role" key space).
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
      out[key] = deepFreeze({ ...op, section: section.key, role });
    }
  }
  return Object.freeze(out);
}
