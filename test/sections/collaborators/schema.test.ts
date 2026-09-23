/**
 * The collaborators section's own parse refusal, pinned as the problem line a user reads: a key outside the grant
 * PUT's two fields. The permission vocabulary is shared with teams and pinned once in ../roles.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function issues(collaborators: unknown): readonly string[] | null {
  return validateSectionShapes({ collaborators }, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

describe("a collaborator entry the grant PUT would silently misread is refused at parse", () => {
  test.each<[what: string, entry: Record<string, unknown>, expected: string[]]>([
    [
      "a misspelled permission key, which would grant the default role instead",
      { username: "octocat", permissions: "admin" },
      [
        'collaborators[0] (username "octocat"): declares "permissions", which this section does not ' +
          'recognize (known keys: username, permission) - a misspelled "permission" key would ' +
          'silently grant the default "push" role instead of the intended one. Fix the key name, or ' +
          "remove it",
      ],
    ],
  ])("%s", (_what, entry, expected) => {
    expect(issues([entry])).toEqual(expected);
  });

  test("the two fields the PUT takes parse", () => {
    expect(issues([{ username: "octocat", permission: "admin" }])).toBeNull();
  });
});
