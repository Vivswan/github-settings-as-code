/**
 * The repository-level variable section factory, the sibling of
 * repo-secrets.ts: GitHub's two repo-scoped variable families (Actions,
 * Copilot agents) expose the same four endpoints under a different path
 * segment and differ only in PAT resource and output noun, so each section
 * module is ONE variablesSection() call carrying its family's facts. The
 * factory sits above the shared variables engine (variables-engine.ts),
 * which owns the value-based reconciliation; the per-environment variables
 * family (environments) consumes the engine directly with its own nested
 * scopes. Selector fan-out for this file is declared in SHARED_FAN_OUT
 * (.github/scripts/changed-sections.ts).
 */

import { z } from "zod";
import { SettingsFile, type UndeclaredPolicyList } from "../../schema.js";
import {
  beginRun,
  call,
  defaultUndeclaredPolicy,
  listAllEnveloped,
  loosen,
  type PatResource,
  parseLive,
  rejectDuplicates,
  type SectionContext,
  type SectionResult,
  undeclaredPolicy,
} from "../contract.js";
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

/** The path segment under /repos/{owner}/{repo} a variable family lives at. */
type VariablesSegment = "actions" | "agents";

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

/** The module shape variablesSection() mints (SectionModule<K> at the registry). */
export interface RepoVariablesSectionModule<
  K extends RepoVariablesKey,
  P extends VariablesSegment,
> {
  readonly key: K;
  readonly undeclaredDefault: "delete";
  readonly permission: { readonly repo: readonly [PatResource] };
  readonly endpoints: RepoVariablesEndpoints<P>;
  readonly shape: z.ZodType;
  run(ctx: SectionContext, declared: RepoVariablesDeclared): Promise<SectionResult>;
}

/**
 * Mint one repository-level variable family's section module. Everything the
 * families share - the upsert-by-case-insensitive-name run, the engine
 * wiring, the delete-undeclared-by-default posture (variables are readable,
 * recreatable configuration; the wrapped `undeclared: keep` form softens
 * deletion to notes) - lives here once; a family supplies only its key, path
 * segment, PAT resource, and noun.
 */
export function variablesSection<K extends RepoVariablesKey, P extends VariablesSegment>(family: {
  key: K;
  /** The API path segment: /repos/{owner}/{repo}/<segment>/variables. */
  pathSegment: P;
  /** The fine-grained-PAT Repository permission gating the family. */
  resource: PatResource;
  /** The output noun ("Actions variable", "Copilot agents variable"). */
  noun: string;
}): RepoVariablesSectionModule<K, P> {
  const { key, pathSegment, resource, noun } = family;
  const endpoints: RepoVariablesEndpoints<P> = {
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
    shape: loosen(SettingsFile.shape[key]),
    async run(ctx, declared): Promise<SectionResult> {
      const run = beginRun(ctx);
      const { policy, entries } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
      // Variable names are case-insensitive on GitHub, so two entries differing
      // only in case name the same variable and would fight on every run.
      rejectDuplicates(
        this,
        entries,
        (variable) => variableKey(variable.name),
        (variable) => variable.name,
      );
      await reconcileVariables(run, this, scope, { entries, policy });
      return run.result;
    },
  };
}
