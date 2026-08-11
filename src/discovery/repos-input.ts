/** Parsing for the "repos" input: explicit slugs or "*" discovery. */

import { SLUG_RE } from "./targets.js";

/** Parse the repos input: comma/newline-separated slugs, or exactly "*". */
export function parseReposInput(
  raw: string,
): { slugs: string[]; discover: boolean } | { error: string } {
  const items = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.includes("*")) {
    if (items.length > 1) {
      return {
        error: `the "repos" input mixes "*" with explicit repositories. Use "*" alone to discover every repository the token owns, or list the repositories without it`,
      };
    }
    return { slugs: [], discover: true };
  }
  // Malformed and repeated entries are collected across the whole list and
  // reported once, so N bad entries cost one run to discover, not N. Both
  // pools are Sets: a bad entry pasted twice is one offender, not two.
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
    const parts: string[] = [];
    if (invalid.size > 0) {
      parts.push(
        `${[...invalid].map((item) => `"${item}"`).join(", ")} ${invalid.size === 1 ? "is not an owner/name slug" : "are not owner/name slugs"} (use values like "octocat/hello-world", comma- or newline-separated)`,
      );
    }
    if (duplicated.size > 0) {
      parts.push(
        `${[...duplicated].map((item) => `"${item}"`).join(", ")} ${duplicated.size === 1 ? "is" : "are"} listed more than once (keep exactly one entry per repository)`,
      );
    }
    return {
      error: `the "repos" input has ${invalid.size + duplicated.size} invalid entr${invalid.size + duplicated.size === 1 ? "y" : "ies"}: ${parts.join("; ")}. Or use "*" alone to discover repositories`,
    };
  }
  return { slugs: items, discover: false };
}
