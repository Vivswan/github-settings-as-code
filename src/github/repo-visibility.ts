/**
 * Redaction fails closed, so the probe never guesses "public": any error, and a 200 body that proves neither public
 * nor private, resolve to "unknown", which the caller redacts.
 */

import type { GithubClient } from "./api.js";

/** A repository's visibility as the probe established it; "unknown" means it could not. */
export type RepoVisibility = "public" | "private" | "internal" | "unknown";

export function createVisibilityResolver(
  api: GithubClient,
): (slug: string) => Promise<RepoVisibility> {
  const cache = new Map<string, Promise<RepoVisibility>>();
  return (slug) => {
    const key = slug.toLowerCase();
    let pending = cache.get(key);
    if (!pending) {
      pending = probe(api, slug);
      cache.set(key, pending);
    }
    return pending;
  };
}

async function probe(api: GithubClient, slug: string): Promise<RepoVisibility> {
  let result: Awaited<ReturnType<GithubClient["tryRequest"]>>;
  try {
    // The probe decides redaction, so its own trace (and any throttle-callback trace) must fail closed before the answer
    // is known: redactTrace holds the slug redacted for the request's duration.
    result = await api.tryRequest("GET", `/repos/${slug}`, undefined, { redactTrace: true });
  } catch {
    // Network-level failure: tryRequest throws once the retries are spent.
    return "unknown";
  }
  if ("error" in result) {
    return "unknown";
  }
  const repo = result.data as { visibility?: unknown; private?: unknown } | null;
  // Fail closed, mirroring discover.ts normalizeVisibility: the always-present `private` flag is the authority, so
  // private === true wins over any `visibility` value.
  if (repo?.private === true) {
    return repo.visibility === "internal" ? "internal" : "private";
  }
  const visibility = repo?.visibility;
  if (visibility === "public" || visibility === "private" || visibility === "internal") {
    return visibility;
  }
  // Only an explicit private === false proves the repo public; anything else is unknown and redacted.
  if (repo?.private === false) {
    return "public";
  }
  return "unknown";
}
