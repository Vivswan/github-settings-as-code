/**
 * The milestones section's parse refusal, pinned as the problem line a user reads: a due date that is neither a
 * calendar day nor the timestamp GitHub keeps on one.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function issues(entries: unknown[]): readonly string[] | null {
  return validateSectionShapes({ milestones: entries }, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

describe("a milestone due date GitHub would 422 is refused at parse, naming the key and the forms", () => {
  test.each<[what: string, due_on: unknown]>([
    ["a day-month-year spelling", "01-10-2026"],
    ["a number", 20261001],
  ])("%s", (_what, due_on) => {
    expect(issues([{ title: "v1", due_on }])).toEqual([
      "milestones[0].due_on: due_on is a calendar day, YYYY-MM-DD (or an ISO 8601 UTC timestamp, YYYY-MM-DDTHH:MM:SSZ, whose time GitHub discards)",
    ]);
  });

  test.each<[what: string, due_on: string]>([
    ["a calendar day", "2026-10-01"],
    ["the timestamp GitHub keeps on that day", "2026-10-01T07:00:00Z"],
  ])("%s parses", (_what, due_on) => {
    expect(issues([{ title: "v1", due_on }])).toBeNull();
  });
});
