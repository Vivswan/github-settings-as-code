/**
 * The three directive keys a layer may write and the two forms of a keyed list they ride on, the one spelling every
 * stage of the fold reads (admit.ts, undeclared.ts, separate-removals.ts, layers.ts). Which location takes which key
 * is docs/operate/layering.md's.
 */

import { isPlainObject } from "../plain-data.js";
import { UNDECLARED_POLICY_SECTIONS } from "../schema.js";

export const LAYERING_KEY = "_layering";

/** The policy knob's key: on a knobbed wrapper (top-level or nested) a value, at a file's top level a directive. */
export const UNDECLARED_KEY = "_undeclared";

/** The one entry-level directive: `_remove: true` names a lower entry by its key and drops it. */
export const REMOVE_KEY = "_remove";

export const KNOBBED: ReadonlySet<string> = new Set(UNDECLARED_POLICY_SECTIONS);

/** A nested keyed list in either form: the bare list, or the nested `{_undeclared, entries}` wrapper; null when neither. */
export interface NestedForm {
  readonly entries: readonly unknown[];
  /** The wrapper's keys besides `entries`; null for the bare list, so the fold can tell the two forms apart. */
  readonly knobs: Readonly<Record<string, unknown>> | null;
}

export function nestedForm(value: unknown): NestedForm | null {
  if (Array.isArray(value)) {
    return { entries: value, knobs: null };
  }
  if (isPlainObject(value) && Array.isArray(value.entries)) {
    const { entries, ...knobs } = value;
    return { entries, knobs };
  }
  return null;
}
