/**
 * Readers for a shape rule whose sibling failed its type and so holds the raw value (reportingBesideFailures in
 * ../contract/module.ts states the contract): the rule judges what it can read and passes over the rest.
 */

/** The string items of a list; none for a value that is not a list, and a raw item is passed over. */
export function stringItems(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * A sibling's value in message prose, total over every value: a string keeps its quotes, another primitive renders
 * as String() does, and anything else by kind, since its contents are its own shape issue to show and rendering
 * them can throw (JSON.stringify on a YAML alias cycle, String() on what a library caller may define).
 */
export function siblingText(value: unknown): string {
  if (Array.isArray(value)) {
    return "a list";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "object":
      return value === null ? "null" : "a mapping";
    case "function":
      return "a function";
    default:
      return String(value);
  }
}

/** Whether a rule may read fields from the value: null, a scalar, and a list read as none. */
export function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
