/** How a soak's random stream ended: the count asked for, the count that ran before the failure cap stopped it, and the failures among those. */
export interface IterationCounts {
  readonly requested: number;
  readonly ran: number;
  readonly failed: number;
}

/** The soak's closing line. fuzz.ts runs its soak on import, so the line lives here where a test can reach it. */
export function iterationSummary({ requested, ran, failed }: IterationCounts): string {
  return `${requested} requested: ${ran} ran, ${ran - failed} ok, ${failed} failed, ${requested - ran} never ran`;
}
