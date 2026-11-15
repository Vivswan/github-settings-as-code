/**
 * The list-input grammar (entries separated by a newline or a comma) and the `repos` input built on it: owner/name
 * slugs, or "*" alone for discovery. A wildcard beside explicit entries is refused as such; a list without one
 * names every malformed or repeated entry in one problem.
 */

import { err, ok, type Result } from "neverthrow";
import { type SlugKey, slugKey } from "../github/slug.js";
import type { ProblemOf, RefusalText } from "../problem.js";
import { parseRepoSlug, type RepoRef } from "./targets.js";

/** What separates the entries of a list input; a single path can never contain one. */
export const LIST_SEPARATOR = /[\n,]/;

export function splitList(value: string): string[] {
  return value
    .split(LIST_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** What a `repos` list resolves to, and every way it is refused: the offenders by text, each with every 1-based place it holds (a repeat's places are those after its first). */
type ReposList = Result<
  { repos: RepoRef[]; discover: boolean },
  | ProblemOf<"repos-input-wildcard-mixed">
  | { code: "offenders"; invalid: Map<string, number[]>; duplicated: Map<string, number[]> }
>;

/** The refusal quotes each offending entry: the form for a run that hides nothing. */
export function parseReposInput(
  raw: string,
): Result<
  { repos: RepoRef[]; discover: boolean },
  ProblemOf<"repos-input-wildcard-mixed" | "repos-input-invalid-entries">
> {
  return readReposList(raw).mapErr((refused) =>
    refused.code === "offenders"
      ? {
          code: "repos-input-invalid-entries",
          invalid: [...refused.invalid.keys()],
          duplicated: [...refused.duplicated.keys()],
        }
      : refused,
  );
}

/** The refusal for a run that hides private repositories: each offending entry is named by every place it holds, never its text. */
function parseHiddenReposInput(
  raw: string,
  revealable: boolean,
): Result<
  { repos: RepoRef[]; discover: boolean },
  ProblemOf<"repos-input-wildcard-mixed" | "repos-input-invalid-entries-hidden">
> {
  return readReposList(raw).mapErr((refused) =>
    refused.code === "offenders"
      ? {
          code: "repos-input-invalid-entries-hidden",
          invalid: [...refused.invalid.values()].flat().sort((a, b) => a - b),
          duplicated: [...refused.duplicated.values()].flat().sort((a, b) => a - b),
          revealable,
        }
      : refused,
  );
}

/** parseReposInput under the run's policy: a hidden `refusals` picks the refusal that names offenders by place. */
export function parseReposInputUnder(
  raw: string,
  refusals: RefusalText,
): Result<
  { repos: RepoRef[]; discover: boolean },
  ProblemOf<
    | "repos-input-wildcard-mixed"
    | "repos-input-invalid-entries"
    | "repos-input-invalid-entries-hidden"
  >
> {
  return refusals.text === "hidden"
    ? parseHiddenReposInput(raw, refusals.revealable)
    : parseReposInput(raw);
}

/** Appends in place: copying the places at each repeat costs quadratic time on a long list of one bad entry. */
function notePlace(pool: Map<string, number[]>, item: string, place: number): void {
  const places = pool.get(item);
  if (places) {
    places.push(place);
  } else {
    pool.set(item, [place]);
  }
}

function readReposList(raw: string): ReposList {
  const items = splitList(raw);
  if (items.includes("*")) {
    if (items.length > 1) {
      return err({ code: "repos-input-wildcard-mixed" });
    }
    return ok({ repos: [], discover: true });
  }
  // Malformed and repeated entries are collected across the whole list, so N bad entries cost one run to discover, not
  // N; the pools are keyed by the entry's text, so a bad entry pasted twice is one offender, at both its places.
  const seen = new Set<SlugKey>();
  const invalid = new Map<string, number[]>();
  const duplicated = new Map<string, number[]>();
  const repos: RepoRef[] = [];
  for (const [index, item] of items.entries()) {
    const parsed = parseRepoSlug(item);
    if (parsed.isErr()) {
      notePlace(invalid, item, index + 1);
      continue;
    }
    const key = slugKey(item);
    if (seen.has(key)) {
      notePlace(duplicated, item, index + 1);
    }
    seen.add(key);
    repos.push(parsed.value);
  }
  if (invalid.size > 0 || duplicated.size > 0) {
    return err({ code: "offenders", invalid, duplicated });
  }
  return ok({ repos, discover: false });
}
