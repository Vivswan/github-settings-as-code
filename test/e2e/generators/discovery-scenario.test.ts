import { expect, test } from "bun:test";
import { compileExcludePattern } from "../../../src/discovery/exclude-pattern.js";
import {
  genDiscoveryScenario,
  narrowExcludePatterns,
  REFUSED_EXCLUDE_PATTERNS,
  wideExcludePatterns,
} from "./discovery-scenario.js";
import { Rng } from "./prng.js";

// The fuzzer predicts a refused run from the pool a pattern was drawn from, so a pattern the grammar judges the other way makes the prediction wrong.
test("the exclude pools agree with the grammar: every accepted pattern compiles and every refused one is refused", () => {
  const accepted = Array.from({ length: 9 }, (_, n) => [
    ...narrowExcludePatterns(n),
    ...wideExcludePatterns(n),
  ]).flat();
  expect(accepted.filter((pattern) => compileExcludePattern(pattern).isErr())).toEqual([]);
  expect(
    REFUSED_EXCLUDE_PATTERNS.filter((pattern) => compileExcludePattern(pattern).isOk()),
  ).toEqual([]);
});

// A redacted run tells such a pattern by position; a generator that stopped spelling one would leave the leak check nothing to judge.
test("some exclude pattern spells the whole slug of a non-public pool repository", () => {
  const spelled: number[] = [];
  for (let seed = 0; seed < 3000; seed++) {
    const { meta } = genDiscoveryScenario(new Rng(seed));
    const patterns = (meta.filters.exclude ?? "").toLowerCase().split(/,\s*/);
    if (meta.pool.some((repo) => repo.visibility !== "public" && patterns.includes(repo.slug))) {
      spelled.push(seed);
    }
  }
  expect(spelled.length).toBeGreaterThan(30);
});
