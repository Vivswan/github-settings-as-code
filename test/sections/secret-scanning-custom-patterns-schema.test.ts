/**
 * The parse-time refusal of a regex field, at the field level: every field is covered and named
 * with its index, and GitHub's own default delimiters and the PCRE-only forms Hyperscan accepts
 * parse clean. The translation itself is pinned next to its module (compilable-form.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

const KEY = "secret_scanning_custom_patterns";
const REFUSAL = "cannot be compiled as a regular expression";

function issues(entry: Record<string, unknown>): readonly string[] {
  return validateSectionShapes({ [KEY]: [entry] }, "settings.yml").match(
    () => [],
    (problem) => problem.issues,
  );
}

const VALID = { name: "internal-token", pattern: "int_[a-z0-9]{8}" };

describe("secret_scanning_custom_patterns regex fields", () => {
  test.each([
    ["pattern", { ...VALID, pattern: "([a-z" }, "pattern"],
    ["start_delimiter", { ...VALID, start_delimiter: "[" }, "start_delimiter"],
    ["end_delimiter", { ...VALID, end_delimiter: "*)" }, "end_delimiter"],
    ["must_match", { ...VALID, must_match: ["[A-Z]", "(?<!x"] }, "must_match[1]"],
    ["must_not_match", { ...VALID, must_not_match: ["a)"] }, "must_not_match[0]"],
    ["a trailing backslash", { ...VALID, pattern: "int_[a-z0-9]{8}\\" }, "pattern"],
  ])(
    "an uncompilable %s is refused at parse with the field path, not at the bulk-create 422",
    (_label, entry, path) => {
      const found = issues(entry);
      expect(found).toHaveLength(1);
      expect(found[0]).toStartWith(`${KEY}[0].${path}: ${REFUSAL} (`);
      expect(found[0]).toContain("Hyperscan");
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
});
