/**
 * Leaf type vocabulary shared by the settings schema and its consumers.
 * Deliberately zod-free: these are the hand-written generic types the zod
 * schemas cannot express (a generic wrapper interface, a compile-time
 * exhaustiveness helper); importers import them from here.
 */

/** What apply does to live resources the settings file does not declare. */
export type UndeclaredPolicy = "keep" | "delete";

/**
 * The wrapped form of a list: the strict {_undeclared, entries, _layering}
 * wrapper knobbed() and nestedKnobbed() build (src/sections/shared/
 * schema-helpers.ts). The two underscored keys are this action's DIRECTIVES,
 * never GitHub settings; each key's meaning is the published description
 * under `UndeclaredPolicyList<*>.<key>` in src/sections/shared/shared.docs.yml,
 * the one source the JSON Schema and the docs render from.
 */
export interface UndeclaredPolicyList<E> {
  _undeclared?: UndeclaredPolicy;
  entries: E[];
  /** Only a TOP-LEVEL section's wrapper takes it (see nestedKnobbed()). */
  _layering?: "merge" | "replace";
}

/**
 * Compile-time exhaustiveness helper: `MustBeNever<Exclude<Union, Covered>>`
 * fails to compile when the Union has a member the Covered set omits. The one
 * definition every exhaustiveness check in this codebase uses (schema.ts,
 * orchestrate.ts, inputs.ts), so the idiom cannot drift between them.
 */
export type MustBeNever<T extends never> = T;

/**
 * Omit distributed over a union: `Omit<A | B, K>` collapses to the common
 * keys, losing each member's own fields, while this keeps one member per arm.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
