/**
 * The team name is the team_slug in every API path, and GitHub answers a wrong one with the same 404 as a team
 * without access: check would report "no access; apply will grant" for a team that has it under its slug, and the
 * grant PUT would 404. Parsed through the loosened document shape, so a rule that survives here reaches the run.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../../src/engine/validate.js";

function verdict(name: unknown): { ok: true } | { issues: readonly string[] } {
  return validateSectionShapes({ teams: [{ name, permission: "push" }] }, "settings.yml").match(
    () => ({ ok: true }) as const,
    (problem) => ({ issues: problem.issues }),
  );
}

describe("a team name that is not a slug never reaches the API path", () => {
  test.each<[what: string, name: string]>([
    ["a plain slug", "core"],
    ["uppercase, which GitHub folds itself", "Core-Team"],
    ["every punctuation a slug allows, with digits", "release_eng.v2-x"],
  ])("a slug parses: %s", (_what, name) => {
    expect(verdict(name)).toEqual({ ok: true });
  });

  test.each<[what: string, name: unknown, message: string | RegExp]>([
    [
      "a display name with a space: the slug it usually has is named",
      "Core Team",
      'teams[0].name: a team is declared by its slug (the name in its URL, /orgs/<org>/teams/<slug>): letters, digits, ".", "_", and "-" only, at least one letter or digit; a team named "Core Team" usually has the slug "core-team"',
    ],
    ["a leading space folded away by the guess", " core", /usually has the slug "core"$/],
    [
      "a path separator, for which no slug can be guessed",
      "core/team",
      'teams[0].name: a team is declared by its slug (the name in its URL, /orgs/<org>/teams/<slug>): letters, digits, ".", "_", and "-" only, at least one letter or digit, and "core/team" is not one',
    ],
    ["an @-prefixed mention", "@core", /and "@core" is not one$/],
    ["an empty name", "", /and "" is not one$/],
    [
      "a lone dot, which a URL path resolves away",
      ".",
      /at least one letter or digit, and "\." is not one$/,
    ],
    ["a parent segment, which resolves to another URL entirely", "..", /and "\.\." is not one$/],
    [
      "a block scalar: the trailing newline is shown escaped",
      "core\n",
      /a team named "core\\n" usually has the slug "core"$/,
    ],
    [
      "a mapping: the pattern check must not run on a non-string, so the type error is the only issue",
      { length: 4 },
      /expected string/,
    ],
  ])("fails at parse naming the entry and the slug rule: %s", (_what, name, message) => {
    expect(verdict(name)).toEqual({
      issues: [
        typeof message === "string"
          ? message
          : expect.stringMatching(new RegExp(`^teams\\[0\\]\\.name: .*${message.source}`)),
      ],
    });
  });
});

describe("every teams refusal, as the user reads it", () => {
  test.each<[what: string, entry: Record<string, unknown>, expected: string[]]>([
    [
      "a misspelled permission key, which would grant the default role instead",
      { name: "core", permissions: "admin" },
      [
        'teams[0] (name "core"): declares "permissions", which this section does not recognize ' +
          '(known keys: name, permission) - a misspelled "permission" key would silently grant the ' +
          'default "push" role instead of the intended one. Fix the key name, or remove it',
      ],
    ],
  ])("%s", (_what, entry, expected) => {
    expect(
      validateSectionShapes({ teams: [entry] }, "settings.yml").match(
        () => null,
        (p) => p.issues,
      ),
    ).toEqual(expected);
  });
});
