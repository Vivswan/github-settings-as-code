/**
 * The prose vocabulary for values that are not plain JSON/YAML data, shared
 * by the two boundaries that reject them: upfront document validation
 * (engine/validate.ts) and the secret-payload normalizer
 * (github/secret-scan.ts). One prototype ladder, so the two boundaries can
 * never describe the same tagged value differently.
 */

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
