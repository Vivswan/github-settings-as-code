/**
 * The workflows section's own parse refusal, pinned as the problem line a user reads: a key outside the two the
 * enable and disable calls read, which send no payload at all.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function issues(entries: unknown[]): readonly string[] | null {
  return validateSectionShapes({ workflows: entries }, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

describe("a workflow entry key the calls cannot carry is refused at parse", () => {
  test.each<[what: string, entry: Record<string, unknown>, expected: string[]]>([
    [
      "an enabled flag beside the state, which would silently do nothing",
      { path: "ci.yml", state: "active", enabled: true },
      [
        'workflows[0] (path "ci.yml"): declares "enabled", which this section does not recognize (known keys: path, state) - the enable/disable calls send no payload, so the key would silently do nothing. Fix the key name, or remove it',
      ],
    ],
  ])("%s", (_what, entry, expected) => {
    expect(issues([entry])).toEqual(expected);
  });

  test("the two keys the calls read parse, in both states", () => {
    expect(
      issues([
        { path: "ci.yml", state: "active" },
        { path: "nightly.yml", state: "disabled" },
      ]),
    ).toBeNull();
  });
});
