/** Count agreement for the prose the run prints: 1 takes the singular, every other count the plural, so no message spells a noun "section(s)". */

export function agree(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function countNoun(count: number, one: string, many: string): string {
  return `${count} ${agree(count, one, many)}`;
}

/** A user-supplied value quoted for a message, so a quote or backslash inside it stays distinguishable. */
export function quote(value: unknown): string {
  return JSON.stringify(String(value));
}
