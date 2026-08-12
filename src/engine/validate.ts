/**
 * Shape validation for one settings document. Each section's loose zod
 * shape lives on its module (sections/<key>.ts); this walks the declared
 * sections and reports every mismatch. Unrecognized keys are rejected HERE,
 * during upfront validation and before any section has written anything,
 * for two kinds of surface: closed sections (a `closedSurface` declaration
 * on the module) and strict nested shapes (a strictObject inside a
 * section's zod shape, e.g. actions.cache).
 */

import { SECTION_KEYS } from "../schema.js";
import { sectionModule, sectionShape } from "../sections/registry.js";

/**
 * The first non-plain object anywhere in a declared value, as "path (kind)"
 * prose - or null when the value is plain JSON data throughout. YAML's
 * explicit tags (!!timestamp, !!set, !!binary) parse to Date/Set/Uint8Array,
 * which zod's object schemas accept as empty mappings, so a tagged value
 * nested ANYWHERE (actions.cache, a pages mapping, a future section) would
 * otherwise validate and then silently configure nothing - or die later at
 * the request boundary with less context. One walk here covers every
 * section, present and future, instead of a per-shape guard that each new
 * mapping must remember (requirePlainMapping remains the shape-level belt
 * for the sections that wear it). `seen` breaks YAML anchor cycles: a
 * cyclic document is not endorsed, but the validator must not hang on one.
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
    const kind =
      proto === Date.prototype
        ? "a Date, e.g. from a YAML !!timestamp tag"
        : proto === Uint8Array.prototype
          ? "binary data, e.g. from a YAML !!binary tag"
          : proto === Set.prototype
            ? "a set, e.g. from a YAML !!set tag"
            : "a non-plain object";
    return `${path} is not plain YAML data (${kind}); replace it with a plain value`;
  }
  for (const [key, entry] of Object.entries(value)) {
    const hit = findNonPlain(entry, `${path}.${key}`, seen);
    if (hit !== null) {
      return hit;
    }
  }
  return null;
}

/**
 * Validate the declared sections' shapes. Returns an error message naming
 * the source file, the exact entries, and what to fix - or null when the
 * document is well-formed. The parsed values are NOT used (zod would clone
 * them); the original document is applied verbatim.
 */
export function validateSectionShapes(
  settings: Record<string, unknown>,
  sourceLabel: string,
): string | null {
  const problems: string[] = [];
  for (const key of SECTION_KEYS) {
    const declared = settings[key];
    if (declared === undefined) {
      continue;
    }
    // Plain-data gate first: zod object schemas accept a Date or Set as an
    // empty mapping, so the tagged-value rejection must not depend on any
    // shape.
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
        // The cap keeps the message readable, but a silently truncated list
        // would cost one fix-and-rerun cycle per hidden offender - say how
        // many more there are.
        problems.push(`${key}: ...and ${issues.length - 5} more issue(s) in this section`);
      }
      continue;
    }
    problems.push(...closedSurfaceProblems(key, declared));
  }
  if (problems.length === 0) {
    return null;
  }
  return `${sourceLabel} has malformed section entries: ${problems.join("; ")}. Fix these values in the settings file (only the named keys are validated; extra fields pass through, except in closed sections and strict nested objects like actions.cache, which reject unrecognized keys)`;
}

/**
 * Unrecognized entry keys in a closed section, capped at 5 like the shape
 * issues above. Runs only after the shape parse succeeded; entries that are
 * not objects are skipped (for the current closed shapes the parse already
 * excludes them, so the guard is only defensive). A knobbed section's
 * wrapped `{undeclared, entries}` form is unwrapped first, so a closed
 * section that also takes the policy knob (collaborators) keeps its entry
 * checks in both forms - the wrapper's own keys are validated by the
 * strictObject in the section shape, never here.
 */
function closedSurfaceProblems(key: (typeof SECTION_KEYS)[number], declared: unknown): string[] {
  // The registry's generic view erases the per-section entry typing (the same
  // erasure sectionShape accepts), so the declaration is re-widened here.
  const closed = sectionModule(key).closedSurface as
    | {
        known: readonly string[];
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
  const known = new Set<string>(closed.known);
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
        `${key}[${closed.describe(record)}]: declares ${list}, which this section does not recognize (known keys: ${closed.known.join(", ")}) - ${closed.consequence}. Fix the key name, or remove it`,
      );
    }
  }
  if (problems.length > 5) {
    // Same cap-with-a-count posture as the shape issues above: readable, but
    // never silently incomplete.
    return [
      ...problems.slice(0, 5),
      `${key}: ...and ${problems.length - 5} more entr${problems.length - 5 === 1 ? "y" : "ies"} with unrecognized keys in this section`,
    ];
  }
  return problems;
}
