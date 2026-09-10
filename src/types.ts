/**
 * Leaf type vocabulary shared by the settings schema and its consumers.
 * Deliberately zod-free: these are the hand-written generic types the zod
 * schemas cannot express (a generic wrapper interface, a compile-time
 * exhaustiveness helper); importers import them from here.
 */

/** What apply does to live resources the settings file does not declare. */
export type UndeclaredPolicy = "keep" | "delete";

/**
 * The wrapped form of a list, overriding what happens to live resources the
 * file does not declare. The plain array form keeps the list's own default
 * policy (for a top-level section that is the section default, and a
 * multi-repo defaults file can set it; a nested list such as
 * environments[].variables has its own fixed default and never inherits
 * one); this wrapper can set it explicitly, and with
 * `undeclared` omitted it behaves exactly like the plain array. The wrapper is
 * this action's own vocabulary (nothing here passes through to GitHub), so
 * its keys are strict: anything besides `undeclared` and `entries` (plus
 * `_layering` on a top-level section's wrapper) is rejected upfront as a typo.
 */
export interface UndeclaredPolicyList<E> {
  /**
   * What apply does to live resources `entries` does not declare: "delete"
   * removes them, "keep" leaves them alone and surfaces each as a note.
   * Omitted, the list's own default applies.
   */
  undeclared?: UndeclaredPolicy;
  /** The declared entries, exactly as the plain array form lists them. */
  entries: E[];
  /**
   * The same kind of knob on the lower-layer axis: how this list combines
   * with the layers BELOW it in a layered merge (engine/layers.ts) - "merge"
   * unions the entries by key, "replace" lets this layer's list win. Omitted,
   * the run's layering applies; a single document never reads it, and the
   * merged document never carries it. Only a TOP-LEVEL section's wrapper
   * takes it: a list nested inside a section entry is replaced wholesale by
   * a higher layer, so its wrapper rejects the key (see nestedKnobbed()).
   */
  _layering?: "merge" | "replace";
}

/**
 * Compile-time exhaustiveness helper: `MustBeNever<Exclude<Union, Covered>>`
 * fails to compile when the Union has a member the Covered set omits. The one
 * definition every exhaustiveness check in this codebase uses (schema.ts,
 * orchestrate.ts, inputs.ts), so the idiom cannot drift between them.
 */
export type MustBeNever<T extends never> = T;
