/**
 * The one plain-mapping test and the one pipeline that describes a value for refusal prose, shared by every boundary
 * that refuses a value (the layer fold, the section schemas, engine/validate.ts, github/secret-scan.ts): a kind is
 * always named the same way, and a boundary that may echo a scalar does so on top of that; the brand that carries
 * the one plainness proof; and the two record accessors that keep a document key from reaching the prototype chain.
 */

declare const provedPlain: unique symbol;

/**
 * The brand's carrier, named so a bundled declaration can print it (it cannot spell the unexported symbol).
 * A type-level mark only: no runtime field, so a branded document still spreads and serializes as written.
 */
export type PlainProof = { readonly [provedPlain]: true };

/**
 * The proof that engine/validate.ts walked a parsed document and found only plain YAML data (no tagged value, no
 * alias cycle, no list with a hole, nothing JSON cannot carry). validateSectionShapes is the ONE mint; the
 * ValidatedSettings document (engine/orchestrate.ts) is built from a ProvedPlain value and nothing else, so a
 * document that skipped the walk cannot become planner input.
 */
export type ProvedPlain<T> = T & PlainProof;

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

/**
 * The kind of a value isPlainObject refused, naming the YAML tag that produces it. Prototype comparison only, the
 * same reflective read the callers already perform; no payload method is ever dispatched.
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

/**
 * A value's kind for refusal prose, never its contents: problem.ts renders layer-fold refusals where a document value
 * (a label name, a private repository's setting) could land in a public log, so the fold's messages name kinds only.
 */
export function describeKind(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  return isPlainObject(value) ? "a mapping" : nonPlainKind(value);
}

/**
 * A value in refusal prose where echoing it is the point: a quoted string, so a YAML "no" is visibly not a boolean,
 * a number or boolean as written, and anything else by kind, since rendering a container can throw (JSON.stringify
 * on a YAML alias cycle, String() on what a library caller may define).
 */
export function describeValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
    case "bigint":
    case "undefined":
      return String(value);
    default:
      return describeKind(value);
  }
}

/** An own property's value: an inherited name (`constructor`) is not a document key. */
export function own<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Set an own data property whatever the key; assigning `__proto__` would set the prototype. */
export function put(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
