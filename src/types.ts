/**
 * Leaf type vocabulary shared by the settings schema and its consumers; zod-free, since these are the generic types
 * the zod schemas cannot express.
 */

/** What apply does to live resources the settings file does not declare. */
export type UndeclaredPolicy = "keep" | "delete";

/**
 * The wrapper knobbed() and nestedKnobbed() build. The underscored keys are this action's DIRECTIVES, never GitHub
 * settings; each key's meaning is published from src/sections/shared/shared.docs.yml, the one source the JSON Schema and the docs render from.
 */
export interface UndeclaredPolicyList<E> {
  _undeclared?: UndeclaredPolicy;
  entries: E[];
  /** Only a TOP-LEVEL section's wrapper takes it (see nestedKnobbed()). */
  _layering?: "merge" | "replace";
}

export type MustBeNever<T extends never> = T;

/**
 * Omit distributed over a union: `Omit<A | B, K>` collapses to the common
 * keys, losing each member's own fields, while this keeps one member per arm.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
