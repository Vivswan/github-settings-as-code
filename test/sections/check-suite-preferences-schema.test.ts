/**
 * GitHub's check-suite preference rules, enforced before the PATCH. An app_id is a positive integer: no app 0 exists
 * and GitHub rejects fractions. One app gets one entry: GitHub keeps whichever it reads last. Without the bound the
 * PATCH reports whatever GitHub answers, late and on every run. Without the pair rule the lost entry is never
 * reported, since no read endpoint exists. Parsed through the loosened document shape, so a rule that survives here
 * reaches the run.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

/** The parsed section is what the PATCH sends, so an accepted document is judged by it, not by a bare verdict. */
function verdict(entries: readonly unknown[]): { parsed: unknown } | { issues: readonly string[] } {
  return validateSectionShapes(
    { check_suite_preferences: { auto_trigger_checks: entries } },
    "settings.yml",
  ).match(
    (settings) => ({ parsed: settings.check_suite_preferences }),
    (problem) => ({ issues: problem.issues }),
  );
}

const APP_ID_RULE =
  /^check_suite_preferences\.auto_trigger_checks\[(\d)\]\.app_id: .*positive integer/;

describe("a check suite preference GitHub would reject or silently overwrite never reaches the PATCH", () => {
  test("distinct positive integer app_ids parse in any order, and an unknown field rides through to the PATCH payload", () => {
    const entries = [
      { app_id: 62410, setting: true },
      { app_id: 1, setting: false, note: "passes through" },
      { app_id: 15368, setting: true },
    ];
    expect(verdict(entries)).toEqual({ parsed: { auto_trigger_checks: entries } });
  });

  test.each<[what: string, app_id: unknown]>([
    ["0, which names no GitHub App", 0],
    ["a negative id", -15368],
    ["a fraction, which GitHub 422s", 15368.5],
    ["a numeric string, which the PATCH would forward verbatim", "15368"],
    ["a value past the safe integer range", 2 ** 53],
  ])(
    "an app_id GitHub rejects fails at parse naming the entry and the rule: %s",
    (_what, app_id) => {
      expect(
        verdict([
          { app_id: 15368, setting: true },
          { app_id, setting: false },
        ]),
      ).toEqual({
        issues: [expect.stringMatching(APP_ID_RULE)],
      });
    },
  );

  test("a repeated app_id is refused as a pair, naming both positions, since GitHub keeps the last and nothing reads it back", () => {
    expect(
      verdict([
        { app_id: 15368, setting: false },
        { app_id: 29310, setting: true },
        { app_id: 15368, setting: true },
        { app_id: 29310, setting: true },
      ]),
    ).toEqual({
      issues: [
        expect.stringMatching(
          /^check_suite_preferences\.auto_trigger_checks\[2\]\.app_id: repeats app_id 15368 from auto_trigger_checks\[0\].*one entry per app/,
        ),
        expect.stringMatching(
          /^check_suite_preferences\.auto_trigger_checks\[3\]\.app_id: repeats app_id 29310 from auto_trigger_checks\[1\].*one entry per app/,
        ),
      ],
    });
  });

  test("a document breaking both rules reports both, so one fix-and-rerun cycle clears it", () => {
    expect(
      verdict([
        { app_id: 15368, setting: false },
        { app_id: 0, setting: true },
        { app_id: 15368, setting: true },
      ]),
    ).toEqual({
      issues: [
        expect.stringMatching(APP_ID_RULE),
        expect.stringMatching(
          /auto_trigger_checks\[2\]\.app_id: repeats app_id 15368 from auto_trigger_checks\[0\]/,
        ),
      ],
    });
  });
});
