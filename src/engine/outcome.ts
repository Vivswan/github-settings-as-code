/**
 * The one outcome model every mode concludes in: the result words, ranked worst first. The engine's per-repository
 * result (./orchestrate.ts) and the snapshot result (./snapshot.ts) are subsets pinned to this list, and the flows fold
 * a run's targets through worstOf(), so no mode can grow a word or a ranking of its own.
 */

/**
 * Worst-first. The healthy words never share a run (clean and drift belong to check, applied to apply, snapshot to
 * snapshot, merged to merge), so their order against each other is never exercised; skipped appears only across a fleet.
 */
export const RUN_RESULTS = [
  "failed",
  "drift",
  "partial",
  "skipped",
  "applied",
  "clean",
  "snapshot",
  "merged",
] as const;

export type RunOutcome = (typeof RUN_RESULTS)[number];

/** The worst result present. Every run has a target, so an empty fold is a caller bug, not a healthy run. */
export function worstOf(results: ReadonlyArray<{ result: RunOutcome }>): RunOutcome {
  const worst = RUN_RESULTS.find((rank) => results.some((r) => r.result === rank));
  if (worst === undefined) {
    throw new Error(
      "BUG: worstOf was given no results; every run concludes over at least one target",
    );
  }
  return worst;
}
