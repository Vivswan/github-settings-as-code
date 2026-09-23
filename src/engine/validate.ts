/** Shape validation against each section's loose zod shape; the parsed output, not the input, is what the engine applies. */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nonPlainKind } from "../plain-data.js";
import type { ProblemOf } from "../problem.js";
import { LIST_SECTIONS, type ListSection, SECTION_KEYS, type SettingsFile } from "../schema.js";
import {
  checksReportingBesideFailures,
  type DeclaredIssue,
  type DeclaredSecretValue,
} from "../sections/contract/module.js";
import { listLayering, sectionModule, sectionShape } from "../sections/registry.js";
import { valueAt } from "../sections/shared/list-section.js";
import { agree, countNoun } from "../text.js";
import { type SettingsSource, validateSecretRef } from "./secret-refs.js";

const LIST_KEYS: ReadonlySet<string> = new Set(LIST_SECTIONS);

function isListSection(key: string): key is ListSection {
  return LIST_KEYS.has(key);
}

/** zod's issue fields this module reads; `legal` is this action's own, set where a shape refuses null itself. */
interface NullIssue {
  code: string;
  expected?: string;
  values?: readonly unknown[];
  errors?: readonly (readonly NullIssue[])[];
  params?: { legal?: string };
}

/** A type, value, or union mismatch is zod's wording, replaced here; a custom issue is the shape's own, kept unless it names the legal values. */
function rewritesForNull(issue: NullIssue): boolean {
  return (
    issue.params?.legal !== undefined ||
    ["invalid_type", "invalid_value", "invalid_union"].includes(issue.code)
  );
}

/** The values a key that refused null does take, in the words of the fix: "true or false", "a string", "a list ([] for none)". */
function legalValues(issue: NullIssue): string {
  if (issue.params?.legal !== undefined) {
    return issue.params.legal;
  }
  switch (issue.code) {
    case "invalid_type":
      return legalOfType(issue.expected);
    case "invalid_value":
      return `one of ${(issue.values ?? []).map((value) => JSON.stringify(value)).join(", ")}`;
    case "invalid_union": {
      const kinds = new Set(
        (issue.errors ?? []).flatMap((arm) => arm.map((inner) => legalValues(inner))),
      );
      return [...kinds].join(", or ");
    }
    default:
      return "a value of the key's own type";
  }
}

function legalOfType(expected: string | undefined): string {
  switch (expected) {
    case "boolean":
      return "true or false";
    case "string":
      return "a string";
    case "number":
    case "int":
      return "a number";
    case "array":
      return "a list ([] for none)";
    case "object":
      return "a mapping of its fields";
    default:
      return expected === undefined ? "a value of the key's own type" : `a ${expected}`;
  }
}

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
 * Every file-only check runs here: the plainness walks, the shape, the closed surface, the section's own validate
 * hook, and the secret-reference check under the document's provenance, so a settings-file mistake fails the run
 * before the preflight barrier and the first write, in every mode and in a section the `sections` input excludes.
 */
export function validateSectionShapes(
  settings: Record<string, unknown>,
  sourceLabel: string,
  secretSource: SettingsSource = "operator",
): Result<SettingsFile, ProblemOf<"settings-malformed-sections">> {
  const problems: string[] = [];
  const parsedSections: Record<string, unknown> = {};
  for (const key of SECTION_KEYS) {
    const declared = settings[key];
    if (declared === undefined) {
      continue;
    }
    const shape = sectionShape(key);
    // A null section is a value only where the section has an off state (Pages, interaction limits); elsewhere it
    // declares nothing and the layered fold would write it as such, so it is refused before any shape parse.
    if (declared === null && !shape.safeParse(null).success) {
      problems.push(
        `${key}: null has no meaning; remove the section or declare its ${LIST_KEYS.has(key) ? "entries" : "fields"}`,
      );
      continue;
    }
    // Before the shape parse: zod would accept the tagged value as an empty mapping and never report it.
    const nonPlain = findOffending(declared, key, nonPlainOffence, "pass");
    if (nonPlain !== null) {
      problems.push(nonPlain);
      continue;
    }
    // The section may compose a rule onto its loosened shape; loosen() itself covers every check beneath.
    const parsed = checksReportingBesideFailures(shape).safeParse(declared);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      for (const issue of issues.slice(0, 5)) {
        const path = z.core.toDotPath([key, ...issue.path]);
        // A null the shape refused is the author saying "empty" where GitHub has no empty state: name the values that
        // exist. A shape's own diagnostic (a custom issue) already names the fix, unless it supplies the legal values itself.
        if (valueAt(declared, issue.path) === null && rewritesForNull(issue as NullIssue)) {
          problems.push(`${path} has no empty state; write ${legalValues(issue as NullIssue)}`);
          continue;
        }
        problems.push(`${path}: ${issue.message}`);
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
      ...secretReferenceProblems(key, parsed.data, secretSource),
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

/**
 * Every designated secret field (SectionModule.secretValues) as a whole-value `$NAME` reference the document's
 * provenance may carry; the label names the owning entry, so the issue sits under the section key alone. No
 * environment is read: check mode and the fold's per-layer validation run it too.
 */
function secretReferenceProblems(
  key: (typeof SECTION_KEYS)[number],
  parsed: unknown,
  source: SettingsSource,
): string[] {
  // The registry's generic view types the declared value per section, so the parsed output is re-widened here.
  const module = sectionModule(key) as {
    secretValues?(declared: unknown): readonly DeclaredSecretValue[];
  };
  const problems: string[] = [];
  for (const { label, value } of module.secretValues?.(parsed) ?? []) {
    const checked = validateSecretRef(value, source, label);
    if (checked.isErr()) {
      problems.push(`${key}: ${checked.error}`);
    }
  }
  return problems;
}

/**
 * Only the entries are checked here, in either form; the wrapper's own keys are the section shape's strictObject to
 * judge. An entry is named by its path as every other issue spells one (`collaborators[2]`, `.entries[2]` under a
 * wrapper), a bracket always holding an index; its identity rides in the text (`(username "octocat")`), so an
 * all-digit identity is never read as an index.
 */
function closedSurfaceProblems(key: (typeof SECTION_KEYS)[number], declared: unknown): string[] {
  // The registry's generic view erases the per-section entry typing, so the declaration is re-widened here.
  const closed = sectionModule(key).closedSurface as
    | { known: Readonly<Record<string, true>>; consequence: string }
    | undefined;
  if (closed === undefined || !isListSection(key)) {
    return [];
  }
  const wrapped =
    typeof declared === "object" &&
    declared !== null &&
    Array.isArray((declared as Record<string, unknown>).entries);
  const entries = Array.isArray(declared)
    ? declared
    : wrapped
      ? ((declared as Record<string, unknown>).entries as unknown[])
      : null;
  if (entries === null) {
    return [];
  }
  const { keyField } = listLayering(key);
  const knownKeys = Object.keys(closed.known);
  const known = new Set<string>(knownKeys);
  const problems: string[] = [];
  entries.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      return;
    }
    const record = entry as Record<string, unknown>;
    const unknown = Object.keys(record).filter((k) => !known.has(k));
    if (unknown.length === 0) {
      return;
    }
    const list = unknown.map((k) => `"${k}"`).join(", ");
    // The shape parse passed, so the entry carries its key field in the form the schema admits.
    const named = `(${keyField} ${JSON.stringify(record[keyField])})`;
    problems.push(
      `${key}${wrapped ? ".entries" : ""}[${index}] ${named}: declares ${list}, which this section does not recognize (known keys: ${knownKeys.join(", ")}) - ${closed.consequence}. Fix the key name, or remove it`,
    );
  });
  if (problems.length > 5) {
    return [
      ...problems.slice(0, 5),
      `${key}: ...and ${problems.length - 5} more ${agree(problems.length - 5, "entry", "entries")} with unrecognized keys in this section`,
    ];
  }
  return problems;
}
