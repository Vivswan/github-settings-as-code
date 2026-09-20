/** Shape validation against each section's loose zod shape; the parsed output, not the input, is what the engine applies. */

import { err, ok, type Result } from "neverthrow";
import { nonPlainKind } from "../plain-data.js";
import type { ProblemOf } from "../problem.js";
import { SECTION_KEYS, type SettingsFile } from "../schema.js";
import { checksReportingBesideFailures, type DeclaredIssue } from "../sections/contract/module.js";
import { sectionModule, sectionShape } from "../sections/registry.js";
import { agree, countNoun } from "../text.js";

/**
 * One walk over a section's value for what no shape can judge, so a new mapping or passthrough field needs no guard
 * of its own; `offence` names the problem at a node. A YAML alias to an ancestor is a cycle JSON cannot carry:
 * refused with its path under "refuse" (on zod's output, so a typed field keeps the shape's own message), passed over
 * under "pass" (on the raw value, where the shape parse still runs). A shared alias between siblings is walked once.
 */
function findOffending(
  value: unknown,
  path: string,
  offence: (value: unknown, at: "item" | "field") => string | null,
  cycles: "refuse" | "pass",
  at: "item" | "field" = "field",
  ancestors: Set<object> = new Set(),
  walked: WeakSet<object> = new WeakSet(),
): string | null {
  const own = offence(value, at);
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
  // Array.from, not map: map skips a hole.
  const children: [string, unknown, "item" | "field"][] = Array.isArray(value)
    ? Array.from(value, (entry, index) => [`${path}[${index}]`, entry, "item"])
    : Object.entries(value).map(([key, entry]) => [`${path}.${key}`, entry, "field"]);
  for (const [childPath, child, childAt] of children) {
    const hit = findOffending(child, childPath, offence, cycles, childAt, ancestors, walked);
    if (hit !== null) {
      return hit;
    }
  }
  ancestors.delete(value);
  return null;
}

/**
 * What the payload proof (contract/plan.ts plainData) would throw on mid-run, judged at one node: a YAML-tagged value
 * (a Date, Set, or Uint8Array from !!timestamp, !!set, !!binary, which a zod object schema accepts as an empty
 * mapping), and what only a library caller's document can hold. An undefined list item becomes null in JSON; an
 * undefined field is dropped, so it passes.
 */
function nonPlainOffence(value: unknown, at: "item" | "field"): string | null {
  const refuse = (what: string): string =>
    `is not plain YAML data (${what}); replace it with a plain value`;
  if (value === undefined) {
    return at === "item" ? refuse("an undefined list item, which JSON would turn into null") : null;
  }
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return null;
    case "object":
      break;
    default:
      return refuse(nonPlainKind(value));
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return refuse("a mapping with a symbol-keyed property, which JSON drops");
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return refuse("a list of a subclass, which JSON serializes as a plain list");
    }
    // Indices from the length, not value.keys(): a named property may shadow the method.
    const indices = new Set(Array.from({ length: value.length }, (_, index) => String(index)));
    if (Object.getOwnPropertyNames(value).some((n) => n !== "length" && !indices.has(n))) {
      return refuse("a list carrying named properties, which JSON drops");
    }
    if (Object.keys(value).length !== value.length) {
      return refuse("a list with a hole (which JSON renders as null) or a non-enumerable item");
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? null : refuse(nonPlainKind(value));
}

/**
 * A typed number field refuses .nan and .inf in its shape; a PASSTHROUGH field carries them into a request body.
 * Judged on zod's output only, so the typed fields keep zod's own message.
 */
function nonFiniteOffence(value: unknown): string | null {
  return typeof value === "number" && !Number.isFinite(value)
    ? `is ${String(value)}, which JSON cannot carry (it would become null); declare a finite number or remove the key`
    : null;
}

/** On zod's output: plainness again, since zod reads a non-enumerable field the raw walk skipped, plus finiteness. */
function parsedOffence(value: unknown, at: "item" | "field"): string | null {
  return nonPlainOffence(value, at) ?? nonFiniteOffence(value);
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
    // The section may compose a rule onto its loosened shape; loosen() itself covers every check beneath.
    const parsed = checksReportingBesideFailures(sectionShape(key)).safeParse(declared);
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
    const unplain = findOffending(parsed.data, key, parsedOffence, "refuse");
    if (unplain !== null) {
      problems.push(unplain);
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
