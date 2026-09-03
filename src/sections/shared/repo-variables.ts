/**
 * The repository-level variable section factory, the sibling of
 * repo-secrets.ts: GitHub's two repo-scoped variable families (Actions,
 * Copilot agents) expose the same four endpoints under a different path
 * segment and differ only in PAT resource and output noun, so each section
 * module is ONE repoVariablesSection() call carrying its family's facts. The
 * factory sits above the shared variables engine (variables-engine.ts),
 * which owns the value-based reconciliation; the per-environment variables
 * family (environments) consumes the engine directly with its own nested
 * scopes. The smoke selector (.github/scripts/changed-sections.ts) derives
 * this file's section fan-out from the import graph.
 */

import { z } from "zod";
import type { SettingsFile } from "../../schema.js";
import type { MustBeNever, UndeclaredPolicyList } from "../../types.js";
import { ActionsVariableConfig } from "../actions_variables/schema.js";
import { AgentsVariableConfig } from "../agents_variables/schema.js";
import { parseLive } from "../contract/live.js";
import { defaultUndeclaredPolicy, loosen, undeclaredPolicy } from "../contract/module.js";
import type { PatResource } from "../contract/permissions.js";
import type { PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "./schema-helpers.js";
import {
  LiveVariable,
  planVariables,
  type VariableEntry,
  type VariablesPlanScope,
  variableKey,
} from "./variables-engine.js";

/** The section keys the factory may mint, each with its API path segment. */
export type RepoVariablesKey = "actions_variables" | "agents_variables";

/**
 * Each family's path segment under /repos/{owner}/{repo}, keyed by section:
 * the factory derives the routes from THIS map, so a key paired with the
 * other family's segment (which the mock would faithfully serve, hiding the
 * swap) is unrepresentable. The `satisfies` pins every VALUE to the segment
 * its own KEY spells, so the map cannot lie either - each section key is
 * exactly `<segment>_variables`.
 */
const VARIABLES_SEGMENTS = {
  actions_variables: "actions",
  agents_variables: "agents",
} as const satisfies { [K in RepoVariablesKey]: SegmentOfVariablesKey<K> };

/**
 * Each family's entry slice (src/sections/<key>/schema.ts), keyed by section
 * like VARIABLES_SEGMENTS: the factory derives the runtime shape from THIS
 * map, so a key paired with the other family's config - structurally
 * identical and invisible to every gate - is unrepresentable.
 */
const VARIABLES_ENTRIES = {
  actions_variables: ActionsVariableConfig,
  agents_variables: AgentsVariableConfig,
} as const satisfies Record<RepoVariablesKey, z.ZodType<VariableEntry>>;

/** The path segment a `<segment>_variables` section key spells. */
type SegmentOfVariablesKey<K extends RepoVariablesKey> = K extends `${infer S}_variables`
  ? S
  : never;

/** The path segment a variable family lives at, derived from its key. */
type VariablesSegment<K extends RepoVariablesKey = RepoVariablesKey> =
  (typeof VARIABLES_SEGMENTS)[K];

/**
 * The four-endpoint dictionary of one family, its routes derived from the
 * family's path segment as LITERAL types - so the registry's
 * SectionEndpointKey union, the typed mock fragments, and USED_PATHS see the
 * same exact roles and routes a hand-written dictionary would declare. A
 * type alias, not an interface, so it keeps the implicit index signature
 * EndpointDict expects.
 */
type RepoVariablesEndpoints<P extends VariablesSegment> = {
  readonly list: {
    readonly route: `GET /repos/{owner}/{repo}/${P}/variables`;
    readonly statuses: { readonly 200: string };
    readonly pageSize: number;
    readonly primaryRead: { readonly notFound: "denied" };
  };
  readonly create: {
    readonly route: `POST /repos/{owner}/{repo}/${P}/variables`;
    readonly statuses: { readonly 201: string };
  };
  readonly update: {
    readonly route: `PATCH /repos/{owner}/{repo}/${P}/variables/{name}`;
    readonly statuses: { readonly 204: string };
  };
  readonly remove: {
    readonly route: `DELETE /repos/{owner}/{repo}/${P}/variables/{name}`;
    readonly statuses: { readonly 204: string };
  };
};

/** The declared value of one family's section, exactly as the settings document types it. */
type RepoVariablesDeclared<K extends RepoVariablesKey> = Exclude<SettingsFile[K], undefined>;

/**
 * One family's plan() over exactly its own dictionary and declared value (the
 * registry's exactness lockstep); indexed by K so the generic factory can
 * assign its one SharedPlan to it.
 */
type RepoVariablesPlan<K extends RepoVariablesKey> = {
  [F in RepoVariablesKey]: (
    ctx: PlanContext<RepoVariablesEndpoints<VariablesSegment<F>>>,
    declared: RepoVariablesDeclared<F>,
  ) => Promise<SectionPlan<PlannedOp<RepoVariablesEndpoints<VariablesSegment<F>>>>>;
}[K];

/** Every family's routes as one dictionary; see repo-secrets.ts for why the plan is written over it. */
type WideEndpoints = RepoVariablesEndpoints<VariablesSegment>;

/** The declared value every family accepts: the entry list, plain or wrapped. */
type WideDeclared = VariableEntry[] | UndeclaredPolicyList<VariableEntry>;

/** The one plan the factory builds, over the wide dictionary. */
type SharedPlan = (
  ctx: PlanContext<WideEndpoints>,
  declared: WideDeclared,
) => Promise<SectionPlan<PlannedOp<WideEndpoints>>>;

/** Mutual assignability - equality up to structure, in both directions. */
type Invariant<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compile-time pin: the shared plan IS each family's exact plan (the repo-secrets.ts pin). */
type _SharedPlanIsEveryFamilyPlan = MustBeNever<
  {
    [K in RepoVariablesKey]: Invariant<SharedPlan, RepoVariablesPlan<K>> extends true ? never : K;
  }[RepoVariablesKey]
>;

/** The module shape repoVariablesSection() mints (SectionModule<K> at the registry). */
export interface RepoVariablesSectionModule<K extends RepoVariablesKey> {
  readonly key: K;
  readonly undeclaredDefault: "delete";
  readonly permission: { readonly repo: readonly [PatResource] };
  readonly endpoints: RepoVariablesEndpoints<VariablesSegment<K>>;
  readonly shape: z.ZodType;
  readonly plan: RepoVariablesPlan<K>;
}

/**
 * Mint one repository-level variable family's section module. Everything the
 * families share - the upsert-by-case-insensitive-name plan, the engine
 * wiring, the delete-undeclared-by-default posture (variables are readable,
 * recreatable configuration; the wrapped `undeclared: keep` form softens
 * deletion to notes) - lives here once, and the routes derive from the key
 * through VARIABLES_SEGMENTS; a family supplies only its key, PAT resource,
 * and noun.
 */
export function repoVariablesSection<K extends RepoVariablesKey>(family: {
  key: K;
  /** The fine-grained-PAT Repository permission gating the family. */
  resource: PatResource;
  /** The output noun ("Actions variable", "Copilot agents variable"). */
  noun: string;
}): RepoVariablesSectionModule<K> {
  const { key, resource, noun } = family;
  const pathSegment: VariablesSegment<K> = VARIABLES_SEGMENTS[key];
  const endpoints: RepoVariablesEndpoints<VariablesSegment<K>> = {
    list: {
      route: `GET /repos/{owner}/{repo}/${pathSegment}/variables`,
      statuses: { 200: `the ${noun}s list` },
      // This list endpoint caps per_page at 30 (not the standard 100); asking
      // for more would be silently clamped and truncate the walk to one page.
      pageSize: 30,
      // A fine-grained token conceals a denied list as 404, which is a
      // denial here: the section stops instead of reading "no variables".
      primaryRead: { notFound: "denied" },
    },
    create: {
      route: `POST /repos/{owner}/{repo}/${pathSegment}/variables`,
      statuses: { 201: "variable created" },
    },
    update: {
      route: `PATCH /repos/{owner}/{repo}/${pathSegment}/variables/{name}`,
      statuses: { 204: "variable updated" },
    },
    remove: {
      route: `DELETE /repos/{owner}/{repo}/${pathSegment}/variables/{name}`,
      statuses: { 204: "variable deleted" },
    },
  };

  const wide: WideEndpoints = endpoints;
  const plan: SharedPlan = async (ctx, declared) => {
    const defaultPolicy = defaultUndeclaredPolicy(section);
    const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);
    // Variable names are case-insensitive on GitHub, so two entries differing
    // only in case name the same variable and would fight on every run.
    rejectDuplicates(
      section,
      entries,
      (variable) => variableKey(variable.name),
      (variable) => variable.name,
    );
    // The engine's operations, built here where the routes are known so the
    // params contract compile-checks ({name} on update/remove).
    type Op = PlannedOp<WideEndpoints>;
    const scope: VariablesPlanScope<
      Extract<Op, { role: "create" }>,
      Extract<Op, { role: "update" }>,
      Extract<Op, { role: "remove" }>
    > = {
      label: key,
      noun,
      list: async () =>
        parseLive(
          section,
          wide.list,
          z.array(LiveVariable),
          await ctx.read.list.listAllEnveloped("variables"),
        ),
      create: (write) => ({
        role: "create",
        payload: write.payload,
        drift: write.drift,
        change: write.change,
      }),
      update: (write) => ({
        role: "update",
        params: { name: write.names.live },
        payload: write.payload,
        drift: write.drift,
        change: write.change,
      }),
      remove: (deletion) => ({
        role: "remove",
        params: { name: deletion.name },
        drift: deletion.drift,
        change: deletion.change,
      }),
    };
    return planVariables(scope, { entries, policy, defaultPolicy });
  };

  const section: RepoVariablesSectionModule<K> = {
    key,
    // Undeclared variables are deleted by default, loudly on purpose; the
    // wrapped `undeclared: keep` form downgrades each to a note.
    undeclaredDefault: "delete",
    permission: { repo: [resource] },
    endpoints,
    shape: loosen(knobbed(VARIABLES_ENTRIES[key])),
    plan,
  };
  return section;
}
