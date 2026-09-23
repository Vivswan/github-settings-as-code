/**
 * The parse-time refusal of a regex field, at the field level: every field is covered and named
 * with its index, and GitHub's own default delimiters and the PCRE-only forms Hyperscan accepts
 * parse clean. The translation itself is pinned next to its module (compilable-form.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";
import { compileFailure } from "../../../src/sections/secret_scanning_custom_patterns/compilable-form.js";

const KEY = "secret_scanning_custom_patterns";

function issues(entry: Record<string, unknown>): readonly string[] {
  return validateSectionShapes({ [KEY]: [entry] }, "settings.yml").match(
    () => [],
    (problem) => problem.issues,
  );
}

const VALID = { name: "internal-token", pattern: "int_[a-z0-9]{8}" };

describe("secret_scanning_custom_patterns regex fields", () => {
  test.each<[label: string, entry: Record<string, unknown>, path: string, bad: string]>([
    ["pattern", { ...VALID, pattern: "([a-z" }, "pattern", "([a-z"],
    ["start_delimiter", { ...VALID, start_delimiter: "[" }, "start_delimiter", "["],
    ["end_delimiter", { ...VALID, end_delimiter: "*)" }, "end_delimiter", "*)"],
    ["must_match", { ...VALID, must_match: ["[A-Z]", "(?<!x"] }, "must_match[1]", "(?<!x"],
    ["must_not_match", { ...VALID, must_not_match: ["a)"] }, "must_not_match[0]", "a)"],
    [
      "a trailing backslash",
      { ...VALID, pattern: "int_[a-z0-9]{8}\\" },
      "pattern",
      "int_[a-z0-9]{8}\\",
    ],
  ])(
    "an uncompilable %s is refused at parse with the field path and the engine's reason, not at the bulk-create 422",
    (_label, entry, path, bad) => {
      expect(issues(entry)).toEqual([
        String(KEY) +
          "[0]." +
          String(path) +
          ": cannot be compiled as a regular expression (" +
          String(compileFailure(bad)) +
          "); fix the expression, or report a documentation issue if Hyperscan accepts it as written " +
          "- the check translates the PCRE-only forms the field docs list before compiling, and " +
          "GitHub can still refuse at apply what Hyperscan alone refuses",
      ]);
    },
  );

  test.each<[label: string, fields: Record<string, unknown>]>([
    [
      "GitHub's documented default delimiters and a Hyperscan-shaped pattern",
      {
        pattern: "\\bint_[a-z0-9]{8}\\b",
        start_delimiter: "\\A|[^0-9A-Za-z]",
        end_delimiter: "\\z|[^0-9A-Za-z]",
        must_match: ["[A-Z]", "[0-9]", "[$%@!]"],
        must_not_match: ["[a-z]{2,}"],
      },
    ],
    [
      "the PCRE-only forms Hyperscan accepts, in every field",
      {
        pattern: "(?P<token>int_[a-z0-9]{8})",
        start_delimiter: "(?#word edge)\\A|[^0-9A-Za-z]",
        end_delimiter: "(?i)\\z|[^0-9A-Za-z]",
        must_match: ["[\\x{41}-\\x{5A}]", "(?>[0-9])++"],
        must_not_match: ["\\Qexample.com\\E"],
      },
    ],
  ])("%s parse clean: a user can declare what GitHub already holds", (_label, fields) => {
    expect(issues({ ...VALID, ...fields })).toEqual([]);
  });

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
