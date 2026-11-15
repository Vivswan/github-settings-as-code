/** How a soak's random stream ended: the count asked for, the count that ran before the failure cap stopped it, and the failures among those. */
export interface IterationCounts {
  readonly requested: number;
  readonly ran: number;
  readonly failed: number;
}

/**
 * Runs iteration 0, 1, ... until `requested` have run or `failureCap` of them have failed, and counts both.
 * `runOne` answers whether its iteration passed. fuzz.ts runs its soak on import, so the loop lives here where a test can drive it.
 */
export async function runIterations(
  requested: number,
  failureCap: number,
  runOne: (index: number) => Promise<boolean>,
): Promise<IterationCounts> {
  let ran = 0;
  let failed = 0;
  while (ran < requested && failed < failureCap) {
    const passed = await runOne(ran);
    ran++;
    if (!passed) {
      failed++;
    }
  }
  return { requested, ran, failed };
}

/** The soak's closing line. */
export function iterationSummary({ requested, ran, failed }: IterationCounts): string {
  return `${requested} requested: ${ran} ran, ${ran - failed} ok, ${failed} failed, ${requested - ran} never ran`;
}
