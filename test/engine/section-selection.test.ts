import { describe, expect, test } from "bun:test";
import { err } from "neverthrow";
import { SectionSelection } from "../../src/engine/section-selection.js";
import type { SectionKey } from "../../src/schema.js";

describe("SectionSelection.of", () => {
  test.each<
    [what: string, only: SectionKey[], required: SectionKey[], excluded: SectionKey[] | null]
  >([
    ["nothing restricted, nothing required", [], [], null],
    ["a required section inside the allowlist", ["labels", "repository"], ["labels"], null],
    ["an empty allowlist restricts nothing, so any required section passes", [], ["labels"], null],
    ["a required section outside the allowlist", ["repository"], ["labels"], ["labels"]],
    [
      "every excluded required section, in the given order, and only those",
      ["repository"],
      ["labels", "milestones", "repository"],
      ["labels", "milestones"],
    ],
  ])("%s", (_what, only, required, excluded) => {
    const selection = SectionSelection.of({ only, required });
    if (excluded === null) {
      expect(selection.map((value) => [value.only, value.required])._unsafeUnwrap()).toEqual([
        new Set(only),
        new Set(required),
      ]);
    } else {
      expect(selection).toEqual(err({ code: "required-sections-excluded" as const, excluded }));
    }
  });

  test("ALL is the empty selection", () => {
    expect(SectionSelection.ALL).toEqual(SectionSelection.of({})._unsafeUnwrap());
  });
});
