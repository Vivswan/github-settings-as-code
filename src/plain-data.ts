/**
 * The one plain-mapping test and the rejection prose, shared by the boundaries that refuse tagged values
 * (engine/validate.ts, github/secret-scan.ts), so no two of them describe the same value differently.
 */

/**
 * A YAML tag (!!timestamp, !!set) parses to a Date or Set, an object too; spread as a mapping it would become `{}` and
 * hand the merge a document nobody wrote. Non-plain objects replace like scalars and survive for validation to reject.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Prototype comparison only, the same reflective read the callers already perform; no payload method is ever dispatched. */
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
