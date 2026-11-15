/** The seed property: one body run over fixed regression seeds, then fresh ones, through fast-check, so a failure names the seed that broke it. */

import fc from "fast-check";

/** Fresh seeds each property draws on top of its regression seeds; every run draws different ones. */
const FRESH_SEEDS = 20;

/** The seeds 0..count-1: the fixed set a property keeps covering on every run. */
export function seedsBelow(count: number): number[] {
  return Array.from({ length: count }, (_, seed) => seed);
}

/** The seed `PROPERTY_SEED` names, run ahead of the regression seeds so a reported failure replays first. */
function replaySeed(): number[] {
  const raw = process.env.PROPERTY_SEED;
  if (raw === undefined || raw === "") {
    return [];
  }
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`PROPERTY_SEED must be a non-negative integer seed, got "${raw}"`);
  }
  return [seed];
}

/**
 * Runs `body` on every regression seed, then on fresh ones, and fails on the first seed whose body throws.
 * The fresh seeds are uniform and never shrunk: a generator seed has no smaller neighbour, so the drawn seed is the report.
 * A count the body keeps across calls covers every seed of the run, the regression seeds included.
 */
export function forEachSeed(regression: readonly number[], body: (seed: number) => void): void {
  const examples = [...replaySeed(), ...regression];
  fc.assert(fc.property(fc.noShrink(fc.noBias(fc.integer({ min: 0, max: 2 ** 31 - 1 }))), body), {
    examples: examples.map((seed): [number] => [seed]),
    numRuns: examples.length + FRESH_SEEDS,
    includeErrorInReport: true,
    reporter: (run) => {
      if (run.failed) {
        const [seed] = run.counterexample ?? [];
        throw new Error(
          `${fc.defaultReportMessage(run)}\nReplay: PROPERTY_SEED=${seed} bun test <this file> -t "<this test>"`,
          { cause: run.errorInstance },
        );
      }
    },
  });
}
