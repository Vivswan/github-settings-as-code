/** Shape validation against each section's loose zod shape; the parsed output, not the input, is what the engine applies. */

import { err, ok, type Result } from "neverthrow";
import { nonPlainKind } from "../plain-data.js";
import type { ProblemOf } from "../problem.js";
import { SECTION_KEYS, type SettingsFile } from "../schema.js";
import { sectionModule, sectionShape } from "../sections/registry.js";

/**
 * zod's object schemas accept a Date, Set, or Uint8Array (YAML !!timestamp, !!set, !!binary) as an empty mapping, so a
 * tagged value where a mapping is expected (actions.cache, a pages mapping) would validate and then silently configure
 * nothing. One walk here covers every section instead of a guard each new mapping must remember; `seen` keeps a YAML
 * anchor cycle from hanging it.
 */
function findNonPlain(value: unknown, path: string, seen: WeakSet<object>): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const hit = findNonPlain(value[index], `${path}[${index}]`, seen);
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return `${path} is not plain YAML data (${nonPlainKind(value)}); replace it with a plain value`;
  }
  for (const [key, entry] of Object.entries(value)) {
    const hit = findNonPlain(entry, `${path}.${key}`, seen);
    if (hit !== null) {
      return hit;
    }
  }
  return null;
}

/** The result is zod's output (fresh plain objects at every node the shape describes), never the caller's document. */
export function validateSectionShapes(
  settings: Record<string, unknown>,
  sourceLabel: string,
): Result<SettingsFile, ProblemOf<"settings-malformed-sections">> {
  const problems: string[] = [];
  const parsedSections: Record<string, unknown> = {};
  for (const key of SECTION_KEYS) {
    const declared = settings[key];
    if (declared === undefined) {
      continue;
    }
    // Before the shape parse: zod would accept the tagged value as an empty mapping and never report it.
    const nonPlain = findNonPlain(declared, key, new WeakSet());
    if (nonPlain !== null) {
      problems.push(nonPlain);
      continue;
    }
    const parsed = sectionShape(key).safeParse(declared);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      for (const issue of issues.slice(0, 5)) {
        const path = issue.path
          .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
          .join("");
        problems.push(`${key}${path}: ${issue.message}`);
      }
      if (issues.length > 5) {
        // A silently truncated list costs one fix-and-rerun cycle per hidden offender.
        problems.push(`${key}: ...and ${issues.length - 5} more issue(s) in this section`);
      }
      continue;
    }
    problems.push(...closedSurfaceProblems(key, parsed.data));
    parsedSections[key] = parsed.data;
  }
  if (problems.length === 0) {
    return ok(parsedSections as SettingsFile);
  }
  return err({ code: "settings-malformed-sections", source: sourceLabel, issues: problems });
}

/** Only the entries are checked here, in either form; the wrapper's own keys are the section shape's strictObject to judge. */
function closedSurfaceProblems(key: (typeof SECTION_KEYS)[number], declared: unknown): string[] {
  // The registry's generic view erases the per-section entry typing, so the declaration is re-widened here.
  const closed = sectionModule(key).closedSurface as
    | {
        known: Readonly<Record<string, true>>;
        describe: (entry: Record<string, unknown>) => string;
        consequence: string;
      }
    | undefined;
  if (closed === undefined) {
    return [];
  }
  const entries = Array.isArray(declared)
    ? declared
    : typeof declared === "object" &&
        declared !== null &&
        Array.isArray((declared as Record<string, unknown>).entries)
      ? ((declared as Record<string, unknown>).entries as unknown[])
      : null;
  if (entries === null) {
    return [];
  }
  const knownKeys = Object.keys(closed.known);
  const known = new Set<string>(knownKeys);
  const problems: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      const list = unknown.map((k) => `"${k}"`).join(", ");
      problems.push(
        `${key}[${closed.describe(record)}]: declares ${list}, which this section does not recognize (known keys: ${knownKeys.join(", ")}) - ${closed.consequence}. Fix the key name, or remove it`,
      );
    }
  }
  if (problems.length > 5) {
    return [
      ...problems.slice(0, 5),
      `${key}: ...and ${problems.length - 5} more entr${problems.length - 5 === 1 ? "y" : "ies"} with unrecognized keys in this section`,
    ];
  }
  return problems;
}
