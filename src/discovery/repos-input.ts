import { err, ok, type Result } from "neverthrow";
import type { ProblemOf } from "../problem.js";
import { SLUG_RE } from "./targets.js";

export function parseReposInput(
  raw: string,
): Result<
  { slugs: string[]; discover: boolean },
  ProblemOf<"repos-input-wildcard-mixed" | "repos-input-invalid-entries">
> {
  const items = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.includes("*")) {
    if (items.length > 1) {
      return err({ code: "repos-input-wildcard-mixed" });
    }
    return ok({ slugs: [], discover: true });
  }
  // Malformed and repeated entries are collected across the whole list, so N bad entries cost one run to discover, not
  // N; the pools are Sets, so a bad entry pasted twice is one offender.
  const seen = new Set<string>();
  const invalid = new Set<string>();
  const duplicated = new Set<string>();
  for (const item of items) {
    if (!SLUG_RE.test(item)) {
      invalid.add(item);
      continue;
    }
    const key = item.toLowerCase();
    if (seen.has(key)) {
      duplicated.add(item);
    }
    seen.add(key);
  }
  if (invalid.size > 0 || duplicated.size > 0) {
    return err({
      code: "repos-input-invalid-entries",
      invalid: [...invalid],
      duplicated: [...duplicated],
    });
  }
  return ok({ slugs: items, discover: false });
}
