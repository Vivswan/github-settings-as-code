/**
 * The vocabulary for values that are not plain JSON/YAML data: the one
 * plain-mapping test, and the rejection prose shared by the boundaries that
 * refuse tagged values (engine/validate.ts, github/secret-scan.ts). One
 * prototype ladder, so no two boundaries describe the same tagged value
 * differently.
 */

/**
 * A PLAIN mapping only: the prototype must be Object.prototype or null. A
 * YAML explicit tag (!!timestamp, !!set) parses to a Date or Set, which is
 * an object too - treating one as a mapping would spread it into `{}` and
 * quietly hand the merge (or a knobbed-section normalization) a document
 * nobody wrote. Non-plain objects REPLACE like scalars, surviving the merge
 * as written for post-merge validation to reject.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The value class of a non-plain value, for rejection prose. Prototype
 * comparison only - the same reflective read the callers already perform;
 * no payload method is ever dispatched.
 */
export function nonPlainKind(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return `a ${typeof value}`;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Date.prototype) {
    return "a Date, e.g. from a YAML !!timestamp tag";
  }
  if (proto === Uint8Array.prototype) {
    return "binary data, e.g. from a YAML !!binary tag";
  }
  if (proto === Set.prototype) {
    return "a set, e.g. from a YAML !!set tag";
  }
  return "a non-plain object";
}
