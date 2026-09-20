/**
 * GitHub's label rules the platform does not enforce for us before the wire: a color must be six hex digits (a name or
 * three-digit shorthand 422s on create, and on an existing label drifts and re-PATCHes every run) and a description is
 * capped at 100 characters. Parsed through the loosened document shape, so a rule that survives here reaches the run.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

function verdict(label: Record<string, unknown>): { ok: true } | { issues: readonly string[] } {
  return validateSectionShapes({ labels: [label] }, "settings.yml").match(
    () => ({ ok: true }) as const,
    (problem) => ({ issues: problem.issues }),
  );
}

describe("a label the API would reject never reaches it", () => {
  test.each<[what: string, color: string]>([
    ["the documented form without the #", "d73a4a"],
    ["uppercase digits with the leading #: admitted here, normalized by the lens", "#FF00AA"],
  ])("a six-digit hex color parses: %s", (_what, color) => {
    expect(verdict({ name: "bug", color })).toEqual({ ok: true });
  });

  test.each<[what: string, color: string]>([
    ["a color name", "red"],
    ["three-digit CSS shorthand", "#fff"],
  ])("a color GitHub 422s fails at parse naming the entry and the rule: %s", (_what, color) => {
    expect(verdict({ name: "bug", color })).toEqual({
      issues: [
        expect.stringMatching(/^labels\[0\]\.color: .*six hex digits.*leading "#" optional/),
      ],
    });
  });

  test.each<[what: string, description: unknown, issues: RegExp[] | null]>([
    ["100 ASCII characters, at the cap", "x".repeat(100), null],
    [
      "100 emoji: the cap counts code points, as JSON Schema maxLength does",
      "\u{1F600}".repeat(100),
      null,
    ],
    [
      "101 ASCII characters",
      "x".repeat(101),
      [/^labels\[0\]\.description: .*100 characters.*this one has 101$/],
    ],
    [
      "101 emoji, the count shown in code points too",
      "\u{1F600}".repeat(101),
      [/^labels\[0\]\.description: .*100 characters.*this one has 101$/],
    ],
    [
      "a mapping with a length key: zod would run the cap check on it, so only the type error may report it",
      { length: 101 },
      [/^labels\[0\]\.description: .*expected string/],
    ],
    [
      "a mapping whose length cannot be compared: the cap check must not reach it and throw",
      { length: { toString: null } },
      [/^labels\[0\]\.description: .*expected string/],
    ],
  ])(
    "GitHub's 100-character description cap holds at parse, counted in code points: %s",
    (_what, description, issues) => {
      expect(verdict({ name: "bug", description })).toEqual(
        issues === null
          ? { ok: true }
          : { issues: issues.map((issue) => expect.stringMatching(issue)) },
      );
    },
  );
});
