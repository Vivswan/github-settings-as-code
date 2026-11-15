import { expect, test } from "bun:test";
import { iterationSummary, runIterations } from "./fuzz-iterations.js";

// The failure cap stops a soak early; a summary that counts the iterations never run as passed reads as a near-green soak.
test.each<[label: string, requested: number, passes: (index: number) => boolean, line: string]>([
  [
    "a soak the failure cap stops",
    50,
    (index) => index < 2,
    "50 requested: 7 ran, 2 ok, 5 failed, 43 never ran",
  ],
  [
    "a soak that runs out",
    50,
    (index) => index % 25 !== 0,
    "50 requested: 50 ran, 48 ok, 2 failed, 0 never ran",
  ],
  ["a battery-only soak", 0, () => true, "0 requested: 0 ran, 0 ok, 0 failed, 0 never ran"],
])(
  "%s is summarized by what ran, not by what was asked for",
  async (_label, requested, passes, line) => {
    const visited: number[] = [];
    const counts = await runIterations(requested, 5, async (index) => {
      visited.push(index);
      return passes(index);
    });
    expect(iterationSummary(counts)).toBe(line);
    expect(visited).toEqual(Array.from({ length: counts.ran }, (_, index) => index));
  },
);
