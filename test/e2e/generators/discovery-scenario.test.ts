import { expect, test } from "bun:test";
import { compileExcludePattern } from "../../../src/discovery/exclude-pattern.js";
import {
  narrowExcludePatterns,
  REFUSED_EXCLUDE_PATTERNS,
  wideExcludePatterns,
} from "./discovery-scenario.js";

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
