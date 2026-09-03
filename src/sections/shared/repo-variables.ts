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
import type { UndeclaredPolicyList } from "../../types.js";
import { ActionsVariableConfig } from "../actions_variables/schema.js";
import { AgentsVariableConfig } from "../agents_variables/schema.js";
import { parseLive } from "../contract/live.js";
import {
  beginRun,
  defaultUndeclaredPolicy,
  loosen,
  type SectionContext,
  type SectionResult,
  undeclaredPolicy,
} from "../contract/module.js";
import type { PatResource } from "../contract/permissions.js";
import { call, listAllEnveloped, rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "./schema-helpers.js";
import {
  LiveVariable,
  reconcileVariables,
  type VariableEntry,
  type VariablesScope,
  type VariablesScopeOps,
  variableKey,
} from "./variables-engine.js";

/** The section keys the factory may mint, each with its API path segment. */
type RepoVariablesKey = "actions_variables" | "agents_variables";

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

/** The declared value every family accepts: the entry list, plain or wrapped. */
type RepoVariablesDeclared = VariableEntry[] | UndeclaredPolicyList<VariableEntry>;

/** The module shape repoVariablesSection() mints (SectionModule<K> at the registry). */
export interface RepoVariablesSectionModule<K extends RepoVariablesKey> {
  readonly key: K;
  readonly undeclaredDefault: "delete";
  readonly permission: { readonly repo: readonly [PatResource] };
  readonly endpoints: RepoVariablesEndpoints<VariablesSegment<K>>;
  readonly shape: z.ZodType;
  run(ctx: SectionContext, declared: RepoVariablesDeclared): Promise<SectionResult>;
}

/**
 * Mint one repository-level variable family's section module. Everything the
 * families share - the upsert-by-case-insensitive-name run, the engine
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

  // The engine's four operations, built here where the routes are known so
  // the params contract compile-checks ({name} on update/remove). The
  // request helpers resolve path params from the ROUTE type, which stays
  // parametric on P inside this generic body, so the ops read the dictionary
  // through the constraint-widened view - each route becomes the finite
  // union over every family segment, on which PathParams resolves.
  const wide: RepoVariablesEndpoints<VariablesSegment> = endpoints;
  const ops: VariablesScopeOps = {
    list: async (ctx, section) =>
      parseLive(
        section,
        wide.list,
        z.array(LiveVariable),
        await listAllEnveloped(ctx, section, wide.list, "variables"),
      ),
    create: (ctx, section, _name, payload) => call(ctx, section, wide.create, { payload }),
    update: (ctx, section, names, payload) =>
      call(ctx, section, wide.update, { params: { name: names.live }, payload }),
    remove: (ctx, section, liveName) =>
      call(ctx, section, wide.remove, { params: { name: liveName } }),
  };

  const scope: VariablesScope = { label: key, noun, ops };

  return {
    key,
    // Undeclared variables are deleted by default, loudly on purpose; the
    // wrapped `undeclared: keep` form downgrades each to a note.
    undeclaredDefault: "delete",
    permission: { repo: [resource] },
    endpoints,
    shape: loosen(knobbed(VARIABLES_ENTRIES[key])),
    async run(ctx, declared): Promise<SectionResult> {
      const run = beginRun(ctx);
      const defaultPolicy = defaultUndeclaredPolicy(this);
      const { policy, entries } = undeclaredPolicy(declared, defaultPolicy);
      // Variable names are case-insensitive on GitHub, so two entries differing
      // only in case name the same variable and would fight on every run.
      rejectDuplicates(
        this,
        entries,
        (variable) => variableKey(variable.name),
        (variable) => variable.name,
      );
      await reconcileVariables(run, this, scope, { entries, policy, defaultPolicy });
      return run.result;
    },
  };
}
