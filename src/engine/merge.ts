/**
 * Deep merge for the defaults-file layer: defaults sit UNDER a target's
 * settings, target keys win. Plain objects merge recursively; arrays,
 * scalars, and null REPLACE - arrays are full payloads everywhere else in
 * this action (subsetDiff, ruleset PUTs), so concatenation would produce a
 * document nobody declared. Inputs are never mutated.
 */

import type { SettingsFile } from "../schema.js";
import { UNDECLARED_POLICY_SECTIONS } from "../schema.js";
import {
  dropWrapperLayering,
  isPlainObject,
  normalizeKnobbedSections,
  resolveUndeclaredPolicies,
} from "./layers.js";

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
 * the helpers in layers.ts), so the wrapped `{undeclared, entries}` form and the
 * plain array form inherit correctly across the layers: a target's plain
 * array inherits a defaults-file policy, a target's explicit policy wins,
 * and a still-unset policy resolves to the section default after the merge.
 * Only a target value carrying its own entries array participates in that
 * inheritance (see isMalformedWrapper).
 */
export function applyDefaults(
  defaults: SettingsFile,
  repoSettings: unknown,
): { settings: unknown; disabled: string[] } {
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
  const merged = deepMerge(normalizedDefaults, normalizedRepo);
  if (!isPlainObject(merged)) {
    // A non-mapping target document rode through untouched (see
    // normalizeKnobbedSections); it has no sections to disable or resolve,
    // and post-merge validation rejects it as written.
    return { settings: merged, disabled: [] };
  }
  const disabled: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === null && (defaults as Record<string, unknown>)[key] != null) {
      delete merged[key];
      disabled.push(key);
    }
  }
  resolveUndeclaredPolicies(merged);
  // The wrapper's `_layering` addresses a layered merge, not this one; the
  // engine never reads it.
  dropWrapperLayering(merged);
  return { settings: merged, disabled };
}
