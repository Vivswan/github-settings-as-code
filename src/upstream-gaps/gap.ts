/**
 * The shapes of one upstream gap: a GitHub feature at least one upstream
 * artifact lags behind. Each gap lives in its own sibling file, constructed
 * by one of the two lifecycle constructors below; the generated index.ts
 * aggregates them (regenerate with `bun .github/scripts/gen-gaps-index.ts`).
 */

import type { Endpoints } from "@octokit/types";

/**
 * A feature whose routes the pinned @octokit/types release does not carry
 * yet (its release cadence trails the API), in octokit's
 * "METHOD /path/{param}" spelling. The gap file carries a MustBeNever
 * tripwire that fails typecheck the moment octokit ships a route; the
 * graduate script then deletes the file (documentedInSpec: true) or rewrites
 * it to a spec-only gap (documentedInSpec: false).
 */
export interface OctokitGap<R extends string = string> {
  readonly kind: "octokit";
  readonly routes: readonly [R, ...R[]];
  /**
   * Whether GitHub's api.github.com OpenAPI descriptor documents the routes.
   * False only for features the descriptor ALSO lags; those are excluded
   * from the trimmed spec and exempted from the e2e unknown-route check via
   * UNDOCUMENTED_ROUTES.
   */
  readonly documentedInSpec: boolean;
}

/**
 * A feature @octokit/types HAS typed but the pinned OpenAPI descriptor still
 * lacks: no tripwire (the routes are keyof Endpoints already, so nothing is
 * supplemental), only the UNDOCUMENTED_ROUTES exemption. Graduates by hand:
 * once a newer descriptor documents the routes, bump UPSTREAM_REF in
 * trim-openapi.ts, delete the file, and regenerate the index and the
 * trimmed spec.
 */
export interface SpecOnlyGap<R extends string = string> {
  readonly kind: "spec-only";
  readonly routes: readonly [R, ...R[]];
}

export type UpstreamGap<R extends string = string> = OctokitGap<R> | SpecOnlyGap<R>;

/**
 * OctokitGap constructor whose `const` type parameter preserves the routes
 * tuple's literal types, so index.ts can derive SupplementalRoute as a
 * literal union instead of widening to string.
 */
export function defineGap<const G extends Omit<OctokitGap, "kind">>(
  gap: G,
): G & { readonly kind: "octokit" } {
  return { ...gap, kind: "octokit" };
}

/**
 * SpecOnlyGap constructor; literal-preserving like defineGap. Its routes are
 * constrained to keyof Endpoints - the lifecycle's invariant that octokit
 * already ships them - so a typo or a not-actually-shipped route fails right
 * here instead of surfacing as a missing SupplementalRoute downstream.
 */
export function defineSpecOnlyGap<const G extends Omit<SpecOnlyGap<keyof Endpoints>, "kind">>(
  gap: G,
): G & { readonly kind: "spec-only" } {
  return { ...gap, kind: "spec-only" };
}

/**
 * The routes GitHub's OpenAPI descriptor does not document: every spec-only
 * gap's, plus those of octokit gaps marked documentedInSpec: false. Generic
 * over the caller's route union so the result keeps its literal typing
 * WITHOUT a cast - and total on an empty gaps list, where an inline flatMap
 * over the literal tuple would stop compiling (its callbacks would receive
 * `never`).
 */
export function undocumentedRoutes<R extends string>(
  gaps: readonly UpstreamGap<R>[],
): readonly R[] {
  return gaps
    .filter((gap) => gap.kind === "spec-only" || !gap.documentedInSpec)
    .flatMap((gap) => gap.routes);
}
