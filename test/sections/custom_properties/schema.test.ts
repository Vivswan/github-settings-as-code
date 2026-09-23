/**
 * The custom_properties section's parse refusals, each pinned as the problem line a user reads: a multi_select value
 * that is an empty list (GitHub does not document whether [] stores or unsets), a repeated option (a set comparison
 * would hide the typo forever), and a key outside the bulk PATCH's two fields.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function issues(entries: unknown[]): readonly string[] | null {
  return validateSectionShapes({ custom_properties: entries }, "settings.yml").match(
    () => null,
    (problem) => problem.issues,
  );
}

describe("a custom property value GitHub would store ambiguously is refused at parse, naming the entry and the fix", () => {
  test.each<[what: string, entry: Record<string, unknown>, expected: string[]]>([
    [
      "an empty list, whose storage GitHub does not document",
      { property_name: "team", value: [] },
      [
        'custom_properties[0].value: the "team" entry declares an empty list; declare value: null to unset the property instead',
      ],
    ],
    [
      "a repeated option in a multi_select value",
      { property_name: "team", value: ["platform", "web", "platform"] },
      [
        'custom_properties[0].value: the "team" entry lists the value "platform" more than once; a multi_select value is a set, so keep each option exactly once',
      ],
    ],
    [
      "a key outside the bulk PATCH body",
      { property_name: "team", value: "platform", values: ["web"] },
      [
        'custom_properties[0] (property_name "team"): declares "values", which this section does ' +
          "not recognize (known keys: property_name, value) - the key would silently never reach " +
          "GitHub and the misdeclared property would keep its live value. Fix the key name, or remove " +
          "it",
      ],
    ],
  ])("%s", (_what, entry, expected) => {
    expect(issues([entry])).toEqual(expected);
  });

  test("every value form GitHub stores parses: a string, a set of options, a boolean, a number, and the null that unsets", () => {
    expect(
      issues([
        { property_name: "team", value: "platform" },
        { property_name: "tags", value: ["web", "api"] },
        { property_name: "critical", value: true },
        { property_name: "tier", value: 2 },
        { property_name: "owner", value: null },
      ]),
    ).toBeNull();
  });
});
