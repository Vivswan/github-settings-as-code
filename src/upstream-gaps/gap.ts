/** Each gap lives in its own sibling file; the generated index.ts aggregates them (bun .github/scripts/gen-gaps-index.ts). */

import type { Endpoints } from "@octokit/types";

/**
 * Routes the pinned @octokit/types does not carry yet. The gap file carries a MustBeNever tripwire that
 * fails typecheck when octokit ships a route; the graduate script then deletes the file
 * (documentedInSpec: true) or rewrites it spec-only (documentedInSpec: false).
 */
export interface OctokitGap<R extends string = string> {
  readonly kind: "octokit";
  readonly routes: readonly [R, ...R[]];
  /**
   * False only for features GitHub's OpenAPI descriptor ALSO lags; those are excluded from the descriptor
   * slice the e2e validator loads and exempted from its unknown-route check via UNDOCUMENTED_ROUTES.
   */
  readonly documentedInSpec: boolean;
}

/**
 * Routes octokit HAS typed but the pinned @octokit/openapi descriptor lacks: no tripwire, only the
 * UNDOCUMENTED_ROUTES exemption. Graduates by hand once a Dependabot bump documents the route (the e2e
 * validator's load fails naming it): delete the file and regenerate the index.
 */
export interface SpecOnlyGap<R extends string = string> {
  readonly kind: "spec-only";
  readonly routes: readonly [R, ...R[]];
}

/**
 * SDL GitHub's GraphQL API serves but the pinned @octokit/graphql-schema release lacks (new types, `extend type`,
 * `extend input`). No tripwire type can see a schema: the lockstep test extends the package's schema with each
 * gap's SDL, and graphql-js refuses the extension once the package ships a declared type or field. Graduates by
 * hand: delete the file and regenerate the index.
 */
export interface GraphqlSchemaGap {
  readonly kind: "graphql-schema";
  readonly sdl: string;
}

export type UpstreamGap<R extends string = string> =
  | OctokitGap<R>
  | SpecOnlyGap<R>
  | GraphqlSchemaGap;

/** `const G` preserves the routes tuple's literals, so index.ts derives SupplementalRoute as a literal union. */
export function defineGap<const G extends Omit<OctokitGap, "kind">>(
  gap: G,
): G & { readonly kind: "octokit" } {
  return { ...gap, kind: "octokit" };
}

/**
 * Routes are constrained to keyof Endpoints (octokit already ships them), so a typo or a not-yet-shipped
 * route fails here instead of as a missing SupplementalRoute downstream.
 */
export function defineSpecOnlyGap<const G extends Omit<SpecOnlyGap<keyof Endpoints>, "kind">>(
  gap: G,
): G & { readonly kind: "spec-only" } {
  return { ...gap, kind: "spec-only" };
}

export function defineGraphqlSchemaGap<const G extends Omit<GraphqlSchemaGap, "kind">>(
  gap: G,
): G & { readonly kind: "graphql-schema" } {
  return { ...gap, kind: "graphql-schema" };
}

/** The gaps keyed by file base name ("lfs" for lfs.ts), as the generated index spells them. */
export type GapsByFile<R extends string = string> = Readonly<Record<string, UpstreamGap<R>>>;

/**
 * Generic over the caller's route union so the result keeps its literal typing WITHOUT a cast, and total
 * on an empty gaps record, where an inline flatMap over the literal values would stop compiling.
 */
export function undocumentedRoutes<R extends string>(gaps: GapsByFile<R>): readonly R[] {
  return Object.values(gaps).flatMap((gap) => {
    if (gap.kind === "graphql-schema") {
      return [];
    }
    return gap.kind === "spec-only" || !gap.documentedInSpec ? gap.routes : [];
  });
}

/** A graphql-schema gap's SDL with the file that carries it, so a refused extension names the file to retire. */
export interface UnshippedGraphqlSdl {
  readonly file: string;
  readonly sdl: string;
}

export function unshippedGraphqlSdl(gaps: GapsByFile): readonly UnshippedGraphqlSdl[] {
  return Object.entries(gaps).flatMap(([base, gap]) =>
    gap.kind === "graphql-schema" ? [{ file: `src/upstream-gaps/${base}.ts`, sdl: gap.sdl }] : [],
  );
}
