import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";
import { permissionForRole, roleForPermission } from "../../src/sections/shared/roles.js";

describe("permissionForRole", () => {
  // One row per branch: the PUT-vocabulary map hit, the custom-role pass-through, the prototype-member guard
  // (a Map, not a record), and both roles no declaration plans as itself.
  test.each([
    ["write", "push"],
    ["admin", "admin"],
    ["constructor", "constructor"],
    // A custom org role passes through as spelled: GitHub matches the name exactly, so lowercasing it would plan a rename.
    ["Security-Team", "Security-Team"],
    // "push" and "pull" are the PUT vocabulary GitHub reads back as write and read, so a live role spelled that way maps nowhere.
    ["push", undefined],
    ["pull", undefined],
  ])("%s reads back as the declared permission %s", (role, permission) => {
    expect(permissionForRole(role)).toBe(permission);
    if (permission !== undefined) {
      expect(roleForPermission(permission)).toBe(role);
    }
  });
});

function verdict(key: "collaborators" | "teams", permission: unknown) {
  const natural = key === "collaborators" ? { username: "octocat" } : { name: "core" };
  return validateSectionShapes({ [key]: [{ ...natural, permission }] }, "settings.yml").match(
    () => ({ ok: true }) as const,
    (problem) => ({ issues: problem.issues }),
  );
}

/**
 * GitHub takes a grant in one vocabulary (pull/push) and reports the role in another (read/write), and the
 * platform never tells the file apart: "write" converges on an existing Write collaborator and 422s on a new
 * one. Each case is judged through both section shapes, so the two sections cannot drift apart.
 */
describe("a permission the grant PUT would 422 never reaches it", () => {
  test.each<[what: string, permission: string]>([
    ["a standard permission", "push"],
    ["the top standard permission", "admin"],
    ["a custom org role name, spelled as the org did", "Security-Team"],
    ["a custom role named like a prototype member", "constructor"],
    ["a custom role that merely contains a standard word", "pushers"],
  ])("parses: %s", (_what, permission) => {
    expect({
      collaborators: verdict("collaborators", permission),
      teams: verdict("teams", permission),
    }).toEqual({
      collaborators: { ok: true },
      teams: { ok: true },
    });
  });

  const OPTIONS = '"pull", "triage", "push", "maintain", "admin", or a custom org role name';

  test.each<[what: string, permission: unknown, message: string | RegExp]>([
    [
      "the read vocabulary of the write role",
      "write",
      `"write" is the vocabulary GitHub reports a role in (role_name), not one a grant accepts; declare "push" (${OPTIONS})`,
    ],
    [
      "the read vocabulary of the read role",
      "read",
      /"read" is the vocabulary GitHub reports.*declare "pull"/,
    ],
    [
      "the read vocabulary, mis-cased too",
      "Write",
      /"Write" is the vocabulary GitHub reports.*declare "push"/,
    ],
    [
      "a mis-cased standard permission",
      "Push",
      '"Push" is not a permission GitHub accepts; the standard permissions are lowercase: declare "push"',
    ],
    [
      "an upper-cased standard permission",
      "ADMIN",
      /"ADMIN" is not a permission GitHub accepts.*declare "admin"$/,
    ],
    [
      "an empty permission",
      "",
      `an empty permission grants nothing; declare ${OPTIONS}, or omit the key for the default "push"`,
    ],
    [
      "a block scalar: the newline is named and the fix is the trimmed standard form",
      "Push\n",
      '"Push\\n" carries whitespace at an end (a YAML block scalar ends in a newline); declare "push"',
    ],
    [
      "a quoted scalar with a leading space, which GitHub would not match",
      " push",
      /carries whitespace at an end.*declare "push"$/,
    ],
    [
      "a block scalar holding a custom role: the fix keeps its spelling",
      "Security-Team\n",
      /carries whitespace at an end.*declare "Security-Team"$/,
    ],
    [
      "a block scalar holding the read vocabulary: the fix is the grant form",
      "write\n",
      /carries whitespace at an end.*declare "push"$/,
    ],
    [
      "a custom role spanning two lines: no fix is suggested, since none would parse",
      "Security\nTeam\n",
      `"Security\\nTeam\\n" spans several lines; a permission is one line: ${OPTIONS}`,
    ],
    [
      "a whitespace-only permission",
      " ",
      `" " (whitespace only) grants nothing; declare ${OPTIONS}, or omit the key for the default "push"`,
    ],
    [
      "a mapping: the pattern check must not run on a non-string, so the type error is the only issue",
      { length: 4 },
      /expected string/,
    ],
  ])(
    "fails at parse naming the entry and the form to declare: %s",
    (_what, permission, message) => {
      const issue = (key: string) => [
        typeof message === "string"
          ? `${key}[0].permission: ${message}`
          : expect.stringMatching(new RegExp(`^${key}\\[0\\]\\.permission: .*${message.source}`)),
      ];
      expect({
        collaborators: verdict("collaborators", permission),
        teams: verdict("teams", permission),
      }).toEqual({
        collaborators: { issues: issue("collaborators") },
        teams: { issues: issue("teams") },
      });
    },
  );
});
