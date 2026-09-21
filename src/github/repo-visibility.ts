/**
 * Redaction fails closed, so the probe never guesses "public": any error, and a 200 body that proves neither public
 * nor private, resolve to "unknown", which the caller redacts.
 */

import type { GitHubClient } from "./api.js";
import { slugKey } from "./slug.js";

/** A repository's visibility as the probe established it; "unknown" means it could not. */
export type RepoVisibility = "public" | "private" | "internal" | "unknown";

export function createVisibilityResolver(
  api: GitHubClient,
): (slug: string) => Promise<RepoVisibility> {
  const cache = new Map<string, Promise<RepoVisibility>>();
  return (slug) => {
    const key = slugKey(slug);
    let pending = cache.get(key);
    if (!pending) {
      pending = probe(api, slug);
      cache.set(key, pending);
    }
    return pending;
  };
}

async function probe(api: GitHubClient, slug: string): Promise<RepoVisibility> {
  // The probe decides redaction, so its own trace (and any throttle-callback trace) must fail closed before the answer
  // is known: redactTrace holds the slug redacted for the request's duration.
  const result = await api.tryRequest("GET", `/repos/${slug}`, undefined, { redactTrace: true });
  if ("failed" in result || "error" in result) {
    return "unknown";
  }
  return classifyVisibility(result.data as { visibility?: unknown; private?: unknown } | null);
}

/**
 * Fails closed for the REDACTION decision. `visibility` is a plain string in the API schema and optional on GHES, so
 * the always-present `private` flag is the authority: private === true wins over any `visibility` (even a stale
 * "public"), and a body that proves neither public nor private is "unknown", which every caller hides.
 */
export function classifyVisibility(
  repo: { visibility?: unknown; private?: unknown } | null,
): RepoVisibility {
  if (repo?.private === true) {
    return repo.visibility === "internal" ? "internal" : "private";
  }
  const visibility = repo?.visibility;
  if (visibility === "public" || visibility === "private" || visibility === "internal") {
    return visibility;
  }
  return repo?.private === false ? "public" : "unknown";
}
