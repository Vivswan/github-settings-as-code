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

// The product names an exclude pattern in its skip notice, so a pattern spelling a private repository's whole slug would put that slug where the leak check forbids it.
test("no exclude pattern spells the whole slug of a non-public pool repository", () => {
  const spelled: string[] = [];
  for (let seed = 0; seed < 3000; seed++) {
    const { meta } = genDiscoveryScenario(new Rng(seed));
    const exclude = (meta.filters.exclude ?? "").toLowerCase();
    for (const repo of meta.pool) {
      if (repo.visibility !== "public" && exclude.split(/,\s*/).includes(repo.slug)) {
        spelled.push(`seed ${seed}: ${meta.filters.exclude}`);
      }
    }
  }
  expect(spelled).toEqual([]);
});
