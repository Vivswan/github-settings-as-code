/** Shape validation against each section's loose zod shape; the parsed output, not the input, is what the engine applies. */

import { err, ok, type Result } from "neverthrow";
import { nonPlainKind } from "../plain-data.js";
import type { ProblemOf } from "../problem.js";
import { SECTION_KEYS, type SettingsFile } from "../schema.js";
import type { DeclaredIssue } from "../sections/contract/module.js";
import { sectionModule, sectionShape } from "../sections/registry.js";
import { agree, countNoun } from "../text.js";

/**
 * One walk over a section's value for what no shape can judge, so a new mapping or passthrough field needs no guard
 * of its own; `offence` names the problem at a node, and a shared alias between siblings is plain data, walked once.
 * A YAML alias to an ancestor is a cycle JSON cannot carry: refused with its path under "refuse" (on zod's output,
 * so a typed field keeps the shape's own message), passed over under "pass" (on the raw value, where the shape
 * parse still runs).
 */
function findOffending(
  value: unknown,
  path: string,
  offence: (value: unknown) => string | null,
  cycles: "refuse" | "pass",
  ancestors: Set<object> = new Set(),
  walked: WeakSet<object> = new WeakSet(),
): string | null {
  const own = offence(value);
  if (own !== null) {
    return `${path} ${own}`;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (cycles === "refuse" && ancestors.has(value)) {
    return `${path} refers back to one of its own containers (a YAML alias cycle), which JSON cannot carry; spell the value out instead`;
  }
  if (walked.has(value)) {
    return null;
  }
  walked.add(value);
  ancestors.add(value);
  const children: [string, unknown][] = Array.isArray(value)
    ? value.map((entry, index) => [`${path}[${index}]`, entry])
    : Object.entries(value).map(([key, entry]) => [`${path}.${key}`, entry]);
  for (const [childPath, child] of children) {
    const hit = findOffending(child, childPath, offence, cycles, ancestors, walked);
    if (hit !== null) {
      return hit;
    }
  }
  ancestors.delete(value);
  return null;
}

/**
 * zod's object schemas accept a Date, Set, or Uint8Array (YAML !!timestamp, !!set, !!binary) as an empty mapping, so a
 * tagged value where a mapping is expected (actions.cache, a pages mapping) would validate and then silently configure
 * nothing. Judged on the raw value, before the shape parse.
 */
function nonPlainOffence(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null
    ? null
    : `is not plain YAML data (${nonPlainKind(value)}); replace it with a plain value`;
}

/**
 * A typed number field refuses .nan and .inf in its shape; a PASSTHROUGH field carries them (and an alias cycle) into a
 * request body, where the payload proof (contract/plan.ts plainData) would throw mid-run, after earlier sections
 * wrote. Judged on zod's output, so the typed fields keep zod's own message.
 */
function nonFiniteOffence(value: unknown): string | null {
  return typeof value === "number" && !Number.isFinite(value)
    ? `is ${String(value)}, which JSON cannot carry (it would become null); declare a finite number or remove the key`
    : null;
}

/**
 * The result is zod's output (fresh plain objects at every node the shape describes), never the caller's document.
 * Every file-only check runs here: the plainness walks, the shape, the closed surface, and the section's own validate
 * hook, so a settings-file mistake fails the run before the preflight barrier and the first write, in every mode.
 */
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
    const nonPlain = findOffending(declared, key, nonPlainOffence, "pass");
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
        problems.push(
          `${key}: ...and ${countNoun(issues.length - 5, "more issue", "more issues")} in this section`,
        );
      }
      continue;
    }
    const nonFinite = findOffending(parsed.data, key, nonFiniteOffence, "refuse");
    if (nonFinite !== null) {
      problems.push(nonFinite);
      continue;
    }
    problems.push(
      ...closedSurfaceProblems(key, parsed.data),
      ...fileOnlyProblems(key, parsed.data),
    );
    parsedSections[key] = parsed.data;
  }
  if (problems.length === 0) {
    return ok(parsedSections as SettingsFile);
  }
  return err({ code: "settings-malformed-sections", source: sourceLabel, issues: problems });
}

/** The section's validate hook over zod's output, its issues rendered under the section key like a zod issue. */
function fileOnlyProblems(key: (typeof SECTION_KEYS)[number], parsed: unknown): string[] {
  // The registry's generic view types the declared value per section, so the parsed output is re-widened here.
  const module = sectionModule(key) as {
    validate?(declared: unknown): readonly DeclaredIssue[];
  };
  return (module.validate?.(parsed) ?? []).map((issue) => `${key}${issue.path}: ${issue.message}`);
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
      `${key}: ...and ${problems.length - 5} more ${agree(problems.length - 5, "entry", "entries")} with unrecognized keys in this section`,
    ];
  }
  return problems;
}
