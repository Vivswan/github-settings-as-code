/**
 * Count agreement for the prose the run prints. Every message that names a count, or lists items it counted, takes
 * the singular or the plural from here, so no message spells a noun "section(s)".
 */

export function agree(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function countNoun(count: number, one: string, many: string): string {
  return `${count} ${agree(count, one, many)}`;
}
