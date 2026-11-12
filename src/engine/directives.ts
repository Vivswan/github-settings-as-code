/**
 * The three directive keys a layer may write and the two forms of a keyed list they ride on, the one spelling every
 * stage of the fold reads (admit.ts, undeclared.ts, separate-removals.ts, layers.ts), and what a run says of a
 * directive written where nothing reads it. Which location takes which key is docs/operate/layering.md's.
 */

import { describeKind, isPlainObject } from "../plain-data.js";
import { UNDECLARED_POLICY_SECTIONS } from "../schema.js";
import { LAYERINGS, type Layering } from "../sections/shared/schema-helpers.js";
import { quote } from "../text.js";

/** The merge directive's key: at a file's top level, or on a list section's wrapper. */
export const LAYERING_KEY = "_layering";

/** The policy knob's key: on a knobbed wrapper (top-level or nested) a value, at a file's top level a directive. */
export const UNDECLARED_KEY = "_undeclared";

/** The one entry-level directive: `_remove: true` names a lower entry by its key and drops it. */
export const REMOVE_KEY = "_remove";

/** The list sections whose wrapper takes the policy knob. */
export const KNOBBED: ReadonlySet<string> = new Set(UNDECLARED_POLICY_SECTIONS);

/** A nested keyed list in either form, the bare list or the nested `{_undeclared, entries}` wrapper; `knobs` holds the wrapper's keys besides `entries`, null for the bare list, so the fold can tell the two forms apart. */
export interface NestedForm {
  readonly entries: readonly unknown[];
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

/** Whether a value is one the `_layering` directive takes. */
export function isLayering(value: unknown): value is Layering {
  return LAYERINGS.some((layering) => layering === value);
}

/** The directives a document writes where nothing reads them, as validateSettingsDoc (orchestrate.ts) finds them. */
export interface UnreadDirectives {
  /** The document's top-level `_layering` as written, undefined when it sets none. */
  readonly layering: unknown;

  /** The path of each `_remove` on an entry no list keys (`SeparatedRemovals.unkeyed`). */
  readonly unkeyed: readonly string[];

  /** A layer's way back from its standalone view to the file as written, applied to each path; a document judged as written passes none. */
  readonly asWritten: ((path: string) => string) | undefined;
}

/**
 * The warning for a top-level `_layering` outside the directive's values, or null where the key is absent or legal.
 * Nothing folds a single document, so the value is never read there; the fold refuses it in a layer (admit.ts), whose
 * standalone view never carries the key this far. The value stays out of the text, as it does in that refusal.
 */
function unreadLayeringNote(source: string, value: unknown): string | null {
  if (value === undefined || isLayering(value)) {
    return null;
  }
  const got = `${describeKind(value)}${typeof value === "string" ? " that is none of them" : ""}`;
  return (
    `${source}: ${LAYERING_KEY} must be one of ${LAYERINGS.map(quote).join(", ")}; got ${got}. ` +
    "A single document is not folded, so the directive is not read and the run goes on; mode: render refuses this " +
    "file as a layer. Write one of the values, or remove the key; the next major version refuses it here too"
  );
}

/** The warning for a `_remove` on an entry no list keys, by the marker's path (`rulesets[0].bypass_actors[0]._remove`). */
export function unkeyedRemovalNote(source: string, path: string): string {
  return (
    `${source}: ${path}: ${REMOVE_KEY} belongs on an entry of a keyed list, and this list is not keyed, so it ` +
    "removes nothing and passes through as a field of the entry. Remove the key; the next major version refuses it"
  );
}

/** One warning per directive the document writes where nothing reads it, each naming `source`: the `_layering` first, then every marker in the walk's order. */
export function unreadDirectiveNotes(source: string, unread: UnreadDirectives): string[] {
  const asWritten = unread.asWritten ?? ((path: string) => path);
  const notes = unread.unkeyed.map((path) => unkeyedRemovalNote(source, asWritten(path)));
  const layering = unreadLayeringNote(source, unread.layering);
  return layering === null ? notes : [layering, ...notes];
}
