/** The seed property: one body run over fixed seeds, then fresh ones, through fast-check, so a failure names the seed that broke it. */

import fc from "fast-check";

/** Fresh seeds each property draws on top of its fixed seeds; every run draws different ones. */
const FRESH_SEEDS = 20;

/** The seeds 0..count-1: the fixed set a property keeps covering on every run. */
export function seedsBelow(count: number): number[] {
  return Array.from({ length: count }, (_, seed) => seed);
}

/** The one seed `PROPERTY_SEED` names, when a reported failure is being replayed. */
function replaySeed(): number | undefined {
  const raw = process.env.PROPERTY_SEED;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`PROPERTY_SEED must be a non-negative integer seed, got "${raw}"`);
  }
  return seed;
}

/**
 * Runs `body` on every fixed seed, then on fresh ones, and fails on the first seed whose body throws, naming it.
 * The fresh seeds are uniform and never shrunk: a generator seed has no smaller neighbour, so the drawn seed is the report.
 * `overFixedSeeds` receives what `body` returned for the fixed seeds alone, in order, so a count across seeds is the same on every run.
 * Under `PROPERTY_SEED` only that seed runs and `overFixedSeeds` is skipped.
 */
export function forEachSeed<T>(
  fixed: readonly number[],
  body: (seed: number) => T,
  overFixedSeeds?: (seen: T[]) => void,
): void {
  const replay = replaySeed();
  const examples = replay === undefined ? fixed : [replay];
  const seen: T[] = [];
  const run = (seed: number): void => {
    const observed = body(seed);
    // The examples run first and in order, so the first `fixed.length` runs are the fixed seeds.
    if (seen.length < fixed.length) {
      seen.push(observed);
    }
  };
  fc.assert(fc.property(fc.noShrink(fc.noBias(fc.integer({ min: 0, max: 2 ** 31 - 1 }))), run), {
    examples: examples.map((seed): [number] => [seed]),
    numRuns: replay === undefined ? fixed.length + FRESH_SEEDS : 1,
    includeErrorInReport: true,
    reporter: (details) => {
      if (details.failed) {
        const [seed] = details.counterexample ?? [];
        throw new Error(
          `${fc.defaultReportMessage(details)}\nReplay: PROPERTY_SEED=${seed} bun test <this file>`,
          { cause: details.errorInstance },
        );
      }
    },
  });
  if (replay === undefined) {
    overFixedSeeds?.(seen);
  }
}
