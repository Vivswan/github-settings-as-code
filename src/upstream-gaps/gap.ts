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
   * False only for features GitHub's OpenAPI descriptor ALSO lags; those are excluded from the trimmed
   * spec and exempted from the e2e unknown-route check via UNDOCUMENTED_ROUTES.
   */
  readonly documentedInSpec: boolean;
}

/**
 * Routes octokit HAS typed but the pinned OpenAPI descriptor lacks: no tripwire, only the
 * UNDOCUMENTED_ROUTES exemption. Graduates by hand: bump UPSTREAM_REF in trim-openapi.ts, delete the
 * file, regenerate the index and the trimmed spec.
 */
export interface SpecOnlyGap<R extends string = string> {
  readonly kind: "spec-only";
  readonly routes: readonly [R, ...R[]];
}

/**
 * A value vocabulary GitHub validates server-side (422) while every pinned upstream artifact types the wire field
 * as a bare string, so the schema refuses unknown values from this hand-kept list at parse time. Graduates by hand:
 * the file's tripwire fires (TS2322, which graduate-upstream-gaps.ts refuses to touch) once @octokit/openapi-types
 * narrows the wire type to a literal union; derive the schema from that union and delete the file.
 */
export interface VocabularyGap<V extends string = string> {
  readonly kind: "vocabulary";
  readonly values: readonly [V, ...V[]];
  /** GitHub's page listing the vocabulary; the refusal message points the reader there. */
  readonly reference: string;
}

export type UpstreamGap<R extends string = string> = OctokitGap<R> | SpecOnlyGap<R> | VocabularyGap;

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

/** `const G` keeps the values tuple's literals, so a schema can build its enum from them. */
export function defineVocabularyGap<const G extends Omit<VocabularyGap, "kind">>(
  gap: G,
): G & { readonly kind: "vocabulary" } {
  return { ...gap, kind: "vocabulary" };
}

/**
 * Generic over the caller's route union so the result keeps its literal typing WITHOUT a cast, and total
 * on an empty gaps list, where an inline flatMap over the literal tuple would stop compiling.
 */
export function undocumentedRoutes<R extends string>(
  gaps: readonly UpstreamGap<R>[],
): readonly R[] {
  return gaps.flatMap((gap) => {
    if (gap.kind === "vocabulary") {
      return [];
    }
    return gap.kind === "spec-only" || !gap.documentedInSpec ? gap.routes : [];
  });
}
