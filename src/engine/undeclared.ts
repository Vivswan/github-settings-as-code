/**
 * The ONE resolution of the undeclared policy, run after the fold (layers.ts) and over a single validated document
 * (orchestrate.ts), so a planner reads an explicit `_undeclared` off every wrapper and never derives one. The
 * precedence it applies: docs/reference/undeclared-policy.md.
 */

import { isPlainObject, own, put } from "../plain-data.js";
import {
  LIST_SECTIONS,
  UNDECLARED_POLICY_SECTIONS,
  type UndeclaredPolicySection,
} from "../schema.js";
import { defaultUndeclaredPolicy, type KeyedListLayering } from "../sections/contract/module.js";
import { listLayering, sectionModule } from "../sections/registry.js";
import type { UndeclaredPolicy } from "../types.js";
import { nestedForm, UNDECLARED_KEY } from "./directives.js";

function sectionDefaultPolicy(key: UndeclaredPolicySection): UndeclaredPolicy {
  return defaultUndeclaredPolicy(sectionModule(key));
}

/**
 * A list in either form with its policy made explicit: the wrapper's own, else `fallback`, else `own` (the list's
 * default). A `_undeclared` that is present but not a policy (null) is left for the validator to refuse; the knob
 * leads the wrapper, where an author's own sits after the fold. A library caller's object can carry the key with an
 * explicit undefined, which is no policy: it is dropped before the resolved one is set, so it cannot overwrite it.
 */
function resolvedWrapper(
  value: unknown,
  fallback: UndeclaredPolicy | undefined,
  own: UndeclaredPolicy,
): unknown {
  const form = nestedForm(value);
  if (form === null || form.knobs?.[UNDECLARED_KEY] !== undefined) {
    return value;
  }
  const { [UNDECLARED_KEY]: _unset, ...knobs } = form.knobs ?? {};
  return { [UNDECLARED_KEY]: fallback ?? own, ...knobs, entries: form.entries };
}

/** An entry with each nested list that takes the knob resolved; entries are shared with the layers, so a resolved one is a new object. */
function resolveNestedPolicies(
  entry: unknown,
  keyed: KeyedListLayering,
  fallback: UndeclaredPolicy | undefined,
): unknown {
  if (!isPlainObject(entry)) {
    return entry;
  }
  let out: Record<string, unknown> | null = null;
  for (const [field, nested] of Object.entries(keyed.nested ?? {})) {
    if (nested.undeclaredDefault === undefined) {
      continue;
    }
    const value = own(entry, field);
    const resolved = resolvedWrapper(value, fallback, nested.undeclaredDefault);
    if (resolved !== value) {
      out ??= { ...entry };
      put(out, field, resolved);
    }
  }
  return out ?? entry;
}

/**
 * Every knobbed section and every nested list that takes the knob comes out in wrapper form with an explicit
 * `_undeclared`: the wrapper's own, else `fallback` (the file's top-level directive, else the run input, both
 * admitted by the caller), else the list's default.
 */
export function resolveUndeclaredPolicies(
  doc: Record<string, unknown>,
  fallback: UndeclaredPolicy | undefined,
): void {
  for (const key of UNDECLARED_POLICY_SECTIONS) {
    const value = own(doc, key);
    if (value !== undefined) {
      put(doc, key, resolvedWrapper(value, fallback, sectionDefaultPolicy(key)));
    }
  }
  for (const key of LIST_SECTIONS) {
    const form = nestedForm(own(doc, key));
    const keyed = listLayering(key);
    if (form === null || keyed.nested === undefined) {
      continue;
    }
    const entries = form.entries.map((entry) => resolveNestedPolicies(entry, keyed, fallback));
    put(doc, key, form.knobs === null ? entries : { ...form.knobs, entries });
  }
}
