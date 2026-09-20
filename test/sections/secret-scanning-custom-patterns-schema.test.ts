/**
 * The five regex fields of a secret scanning custom pattern reach GitHub as opaque strings, so a
 * typo in one used to surface only as a bulk-create 422 whose hint guesses at the cause. These pin
 * the parse-time refusal and the two facts it rests on: a flagless JS RegExp accepts GitHub's own
 * default delimiters (`\A` and `\z` are identity escapes without the u flag), and GitHub documents
 * option modifiers such as `(?i)` as unsupported.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

const KEY = "secret_scanning_custom_patterns";
const REFUSAL = "cannot be compiled as a JavaScript regular expression";

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
    ["must_not_match", { ...VALID, must_not_match: ["a++"] }, "must_not_match[0]"],
    // GitHub's reference says Hyperscan option modifiers are not supported, so refusing them here
    // matches the upstream verdict instead of waiting for it.
    ["an option modifier", { ...VALID, pattern: "(?i)int_[a-z0-9]{8}" }, "pattern"],
  ])(
    "an uncompilable %s is refused at parse with the field path, not at the bulk-create 422",
    (_label, entry, path) => {
      const found = issues(entry);
      expect(found).toHaveLength(1);
      expect(found[0]).toStartWith(`${KEY}[0].${path}: ${REFUSAL} (`);
      expect(found[0]).toContain("Hyperscan");
    },
  );

  test("GitHub's documented default delimiters and a Hyperscan-shaped pattern parse clean", () => {
    expect(
      issues({
        ...VALID,
        pattern: "\\bint_[a-z0-9]{8}\\b",
        start_delimiter: "\\A|[^0-9A-Za-z]",
        end_delimiter: "\\z|[^0-9A-Za-z]",
        must_match: ["[A-Z]", "[0-9]", "[$%@!]"],
        must_not_match: ["[a-z]{2,}"],
      }),
    ).toEqual([]);
  });
});
