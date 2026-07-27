/**
 * Deep merge for the defaults-file layer: defaults sit UNDER a target's
 * settings, target keys win. Plain objects merge recursively; arrays,
 * scalars, and null REPLACE - arrays are full payloads everywhere else in
 * this action (subsetDiff, ruleset PUTs), so concatenation would produce a
 * document nobody declared. Inputs are never mutated.
 */

import type { SettingsFile, UndeclaredPolicy } from "../schema.js";
import { UNDECLARED_POLICY_SECTIONS } from "../schema.js";
import { defaultUndeclaredPolicy } from "../sections/contract.js";
import { sectionModule } from "../sections/registry.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return structuredClone(base);
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return structuredClone(override);
  }
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(override)])) {
    out[key] = key in override ? deepMerge(base[key], override[key]) : structuredClone(base[key]);
  }
  return out;
}

/**
 * Step 1 of the knobbed-section merge: rewrite each UNDECLARED_POLICY_SECTIONS
 * value from the plain array form to the wrapped one, PRESERVING OMISSION of
 * the policy key - a plain array becomes `{entries}` with NO `undeclared`.
 * That omission is what lets deepMerge inherit a defaults-file policy: had
 * the plain form been resolved to its default here, the target's resolved
 * default would overwrite the defaults' explicit policy in the merge. Values
 * in neither form (null opt-outs, malformed declarations) pass through
 * untouched so the null semantics and post-merge validation see them as
 * written. Returns a shallow copy; the input is never mutated.
 */
function normalizeKnobbedSections(settings: SettingsFile): unknown {
  // A document that is not a mapping (a raw list, a scalar) has no sections
  // to normalize; hand it to deepMerge untouched so the top-level validator
  // still sees exactly what was written.
  if (!isPlainObject(settings)) {
    return settings;
  }
  const out: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = { entries: value };
    }
  }
  return out;
}

/** The section's own default policy, from its undeclaredDefault declaration. */
function sectionDefaultPolicy(key: (typeof UNDECLARED_POLICY_SECTIONS)[number]): UndeclaredPolicy {
  return defaultUndeclaredPolicy(sectionModule(key));
}

/**
 * Step 2, after the merge: a wrapped section that still carries no explicit
 * policy resolves to the section's default, so the merged document is
 * self-describing. Runs on the merged clone, so no input is touched.
 */
function resolveUndeclaredPolicies(merged: Record<string, unknown>): void {
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = merged[key];
    if (isPlainObject(value) && Array.isArray(value.entries) && value.undeclared === undefined) {
      value.undeclared = sectionDefaultPolicy(key);
    }
  }
}

/**
 * A knobbed-section value that would MERGE with a defaults-file wrapper but
 * is not itself a valid wrapper: a mapping without its own entries array
 * (`{undeclared: delete}`, `{}`). Left to deepMerge, such a target would
 * silently inherit the defaults' `entries` and turn into a well-formed -
 * and possibly destructive - declaration that validates in multi-repo mode
 * while the same file fails validation standalone. These values must
 * REPLACE the defaults instead, so post-merge validation rejects them as
 * written.
 *
 * The invariant this enforces is more general than the one section family
 * it covers: a target's declaration must be valid on its own terms, never
 * completed into validity by the defaults. If a future section family
 * gains a required field a defaults file could supply, the same
 * single-repo/multi-repo divergence reappears and needs the same guard.
 */
function isMalformedWrapper(value: unknown): boolean {
  return isPlainObject(value) && !Array.isArray(value.entries);
}

/**
 * Merge the central defaults document under one target's settings. A
 * TOP-LEVEL section whose merged value is null is the target's explicit
 * opt-out of that defaults section, but only when the defaults file
 * declares that section: it is stripped from the result and reported in
 * `disabled` so the caller can say so out loud. A null section the
 * defaults do not declare passes through to the engine, where null can
 * carry meaning of its own (pages: null disables GitHub Pages).
 *
 * Knobbed list sections merge in two steps (normalize, then resolve; see
 * the helpers above), so the wrapped `{undeclared, entries}` form and the
 * plain array form inherit correctly across the layers: a target's plain
 * array inherits a defaults-file policy, a target's explicit policy wins,
 * and a still-unset policy resolves to the section default after the merge.
 * Only a target value carrying its own entries array participates in that
 * inheritance (see isMalformedWrapper).
 */
export function applyDefaults(
  defaults: SettingsFile,
  repoSettings: SettingsFile,
): { settings: SettingsFile; disabled: string[] } {
  const normalizedDefaults = normalizeKnobbedSections(defaults);
  const normalizedRepo = normalizeKnobbedSections(repoSettings);
  if (isPlainObject(normalizedDefaults) && isPlainObject(normalizedRepo)) {
    for (const key of UNDECLARED_POLICY_SECTIONS) {
      // normalizeKnobbedSections returned a shallow copy, so dropping the
      // defaults' key here never touches the caller's document.
      if (isMalformedWrapper(normalizedRepo[key])) {
        delete normalizedDefaults[key];
      }
    }
  }
  const merged = deepMerge(normalizedDefaults, normalizedRepo) as Record<string, unknown>;
  const disabled: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === null && (defaults as Record<string, unknown>)[key] != null) {
      delete merged[key];
      disabled.push(key);
    }
  }
  resolveUndeclaredPolicies(merged);
  return { settings: merged as SettingsFile, disabled };
}
