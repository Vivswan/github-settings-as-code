/**
 * Leaf type vocabulary shared by the settings schema and its consumers; zod-free, since these are the generic types
 * the zod schemas cannot express.
 */

/** What apply does to live resources the settings file does not declare. */
export type UndeclaredPolicy = "keep" | "delete";

/**
 * The wrapper knobbed() and nestedKnobbed() build. The underscored keys are this action's DIRECTIVES, never GitHub
 * settings; each key's meaning is published from docs/sections/shared.docs.yml, the one source the JSON Schema and the docs render from.
 */
export interface UndeclaredPolicyList<E> {
  _undeclared?: UndeclaredPolicy;
  entries: E[];
  /** Only a TOP-LEVEL section's wrapper takes it (see nestedKnobbed()); the values are LAYERINGS in src/sections/shared/schema-helpers.ts, pinned there. */
  _layering?: "replace" | "shallow" | "deep";
}

export type MustBeNever<T extends never> = T;

/** `Omit<A | B, K>` collapses to the common keys, losing each member's own fields; this keeps one member per arm. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Readonly through every nested object and array; functions pass untouched. The type twin of a deep Object.freeze. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [P in keyof T]: DeepReadonly<T[P]> }
    : T;
