/**
 * The shape of one upstream gap: a GitHub feature whose routes the pinned
 * @octokit/types release does not carry yet (its release cadence trails the
 * API). Each gap lives in its own sibling file, so graduating a feature once
 * octokit ships it means deleting that file (and its two index.ts lines).
 */

/** One pending feature's routes, in octokit's "METHOD /path/{param}" spelling. */
export interface Gap<R extends string = string> {
  readonly routes: readonly [R, ...R[]];
  /**
   * Whether GitHub's api.github.com OpenAPI descriptor documents the routes.
   * False only for features the descriptor ALSO lags (LFS today); those are
   * excluded from the trimmed spec and exempted from the e2e unknown-route
   * check via UNDOCUMENTED_ROUTES.
   */
  readonly documentedInSpec: boolean;
}

/**
 * Identity constructor whose `const` type parameter preserves the routes
 * tuple's literal types, so index.ts can derive SupplementalRoute as a
 * literal union instead of widening to string.
 */
export function defineGap<const G extends Gap>(gap: G): G {
  return gap;
}

/**
 * The routes of the gaps the OpenAPI descriptor does not document either
 * (documentedInSpec: false). Generic over the caller's route union so the
 * result keeps its literal typing WITHOUT a cast - and total on an empty
 * gaps list, where an inline flatMap over the literal tuple would stop
 * compiling (its callbacks would receive `never`).
 */
export function undocumentedRoutes<R extends string>(gaps: readonly Gap<R>[]): readonly R[] {
  return gaps.filter((gap) => !gap.documentedInSpec).flatMap((gap) => gap.routes);
}
