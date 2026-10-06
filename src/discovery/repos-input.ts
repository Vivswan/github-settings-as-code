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

export function parseReposInput(
  raw: string,
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
  // N; the pools are Sets, so a bad entry pasted twice is one offender.
  const seen = new Set<SlugKey>();
  const invalid = new Set<string>();
  const duplicated = new Set<string>();
  const repos: RepoRef[] = [];
  for (const item of items) {
    const parsed = parseRepoSlug(item);
    if (parsed.isErr()) {
      invalid.add(item);
      continue;
    }
    const key = slugKey(item);
    if (seen.has(key)) {
      duplicated.add(item);
    }
    seen.add(key);
    repos.push(parsed.value);
  }
  if (invalid.size > 0 || duplicated.size > 0) {
    return err({
      code: "repos-input-invalid-entries",
      invalid: [...invalid],
      duplicated: [...duplicated],
    });
  }
  return ok({ repos, discover: false });
}
