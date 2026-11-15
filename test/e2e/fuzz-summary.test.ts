import { expect, test } from "bun:test";
import { iterationSummary } from "./fuzz-summary.js";

// The failure cap stops a soak early; a line that counts the iterations never run as passed reads as a near-green soak.
test.each<[label: string, requested: number, ran: number, failed: number, line: string]>([
  ["a soak the failure cap stopped", 50, 7, 5, "50 requested: 7 ran, 2 ok, 5 failed, 43 never ran"],
  ["a soak that ran out", 50, 50, 2, "50 requested: 50 ran, 48 ok, 2 failed, 0 never ran"],
  ["a battery-only soak", 0, 0, 0, "0 requested: 0 ran, 0 ok, 0 failed, 0 never ran"],
])(
  "the iteration summary of %s counts what ran, not what was asked for",
  (_label, requested, ran, failed, line) => {
    expect(iterationSummary({ requested, ran, failed })).toBe(line);
  },
);
