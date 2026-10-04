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
