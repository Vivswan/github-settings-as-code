/**
 * The list-input grammar (entries separated by a newline or a comma) and the `repos` input built on it: owner/name
 * slugs, or "*" alone for discovery. A wildcard beside explicit entries is refused as such; a list without one
 * names every malformed or repeated entry in one problem.
 */

import { err, ok, type Result } from "neverthrow";
import { type SlugKey, slugKey } from "../github/slug.js";
import type { ProblemOf } from "../problem.js";
import { parseRepoSlug, type RepoRef } from "./targets.js";

/** What separates the entries of a list input; a single path can never contain one. */
export const LIST_SEPARATOR = /[\n,]/;

export function splitList(value: string): string[] {
  return value
    .split(LIST_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `entries: "hidden"` names each refused entry by its 1-based place among the list's entries, for a run that hides private repositories. */
export function parseReposInput(
  raw: string,
  entries: "shown" | "hidden" = "shown",
): Result<
  { repos: RepoRef[]; discover: boolean },
  ProblemOf<"repos-input-wildcard-mixed" | "repos-input-invalid-entries">
> {
  const items = splitList(raw);
  if (items.includes("*")) {
    if (items.length > 1) {
      return err({ code: "repos-input-wildcard-mixed" });
    }
    return ok({ repos: [], discover: true });
  }
  // Malformed and repeated entries are collected across the whole list, so N bad entries cost one run to discover, not
  // N; the pools are keyed by the entry's text, so a bad entry pasted twice is one offender, at its first place.
  const seen = new Set<SlugKey>();
  const invalid = new Map<string, number>();
  const duplicated = new Map<string, number>();
  const repos: RepoRef[] = [];
  for (const [index, item] of items.entries()) {
    const parsed = parseRepoSlug(item);
    if (parsed.isErr()) {
      invalid.set(item, invalid.get(item) ?? index + 1);
      continue;
    }
    const key = slugKey(item);
    if (seen.has(key)) {
      duplicated.set(item, duplicated.get(item) ?? index + 1);
    }
    seen.add(key);
    repos.push(parsed.value);
  }
  if (invalid.size > 0 || duplicated.size > 0) {
    return err(
      entries === "hidden"
        ? {
            code: "repos-input-invalid-entries",
            entries: "hidden",
            invalid: [...invalid.values()],
            duplicated: [...duplicated.values()],
          }
        : {
            code: "repos-input-invalid-entries",
            entries: "shown",
            invalid: [...invalid.keys()],
            duplicated: [...duplicated.keys()],
          },
    );
  }
  return ok({ repos, discover: false });
}
