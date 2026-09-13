/**
 * The one ranking every mode folds through: worst first, over the words of every mode at once.
 */

import { describe, expect, test } from "bun:test";
import { RUN_RESULTS, type RunOutcome, worstOf } from "../../src/engine/outcome.js";

describe("worstOf", () => {
  test.each<[RunOutcome[], RunOutcome]>([
    [["clean", "failed", "drift"], "failed"],
    [["clean", "drift"], "drift"],
    [["applied", "partial", "skipped"], "partial"],
    [["applied", "skipped"], "skipped"],
    [["snapshot", "partial"], "partial"],
    [["snapshot", "failed"], "failed"],
  ])("%j -> %s", (results, worst) => {
    expect(worstOf(results.map((result) => ({ result })))).toBe(worst);
  });

  test("every word ranks, once", () => {
    expect(new Set(RUN_RESULTS).size).toBe(RUN_RESULTS.length);
    for (const result of RUN_RESULTS) {
      expect(worstOf([{ result }])).toBe(result);
    }
  });

  test("no results is a bug, never a healthy fold", () => {
    expect(() => worstOf([])).toThrow("BUG: worstOf was given no results");
  });
});
