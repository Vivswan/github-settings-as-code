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

  test("a spread or a literal is not a selection: the fields are private, so only `of` mints one", () => {
    // Public fields would make the spread typecheck; its directive then reports unused.
    // @ts-expect-error a spread keeps no private members, so it is not a SectionSelection
    const spread: SectionSelection = {
      ...SectionSelection.ALL,
      only: new Set<SectionKey>(["repository"]),
      required: new Set<SectionKey>(["labels"]),
    };
    // @ts-expect-error an object literal cannot supply private members
    const literal: SectionSelection = {
      only: new Set<SectionKey>(),
      required: new Set<SectionKey>(),
    };
    expect([spread.only, literal.only]).toEqual([new Set(["repository"]), new Set()]);
  });
});
