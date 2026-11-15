/**
 * The parse-time checks of a pattern entry: what the settings file alone shows wrong (an empty delimiter, a key the
 * endpoints do not take) is refused naming the field. A regex field's content is GitHub's to judge.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

const KEY = "secret_scanning_custom_patterns";

function issues(entry: Record<string, unknown>): readonly string[] {
  return validateSectionShapes({ [KEY]: [entry] }, "settings.yml").match(
    () => [],
    (problem) => problem.issues,
  );
}

const VALID = { name: "internal-token", pattern: "int_[a-z0-9]{8}" };

describe("secret_scanning_custom_patterns entry", () => {
  test.each<[what: string, entry: Record<string, unknown>, expected: string[]]>([
    [
      "an empty delimiter, which cannot clear the stored one",
      { ...VALID, start_delimiter: "" },
      [
        `${KEY}[0].start_delimiter: a delimiter cannot be cleared with an empty string; remove the pattern and redeclare it without the field instead`,
      ],
    ],
    [
      "a read-only field copied from the GET response",
      { ...VALID, state: "enabled" },
      [
        String(KEY) +
          '[0] (name "internal-token"): declares "state", which this section does not recognize ' +
          "(known keys: name, pattern, start_delimiter, end_delimiter, must_match, must_not_match) - " +
          'the pattern endpoints accept no other field - in particular "state" and ' +
          '"push_protection_enabled" are read-only through this API surface - so the key would be ' +
          "dropped silently and never converge. Fix the key name, or remove it",
      ],
    ],
  ])("every refusal, as the user reads it: %s", (_what, entry, expected) => {
    expect(issues(entry)).toEqual(expected);
  });
});
