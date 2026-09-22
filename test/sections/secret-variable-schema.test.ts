/**
 * GitHub's rules for secret and variable names and for a variable value's size are enforced by the API alone, as a
 * 422 in the middle of an apply; these pin that every family refuses them when the file is parsed, on the rendered
 * problem line a user reads.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";
import { MAX_VARIABLE_VALUE_BYTES } from "../../src/sections/shared/schema-helpers.js";

type Noun = "secret" | "variable";

/** One entry list per family, keyed by where its `name` sits in the rendered path. */
const FAMILIES: Array<{
  noun: Noun;
  path: string;
  doc: (entry: Record<string, unknown>) => Record<string, unknown>;
}> = [
  ...(
    ["actions_secrets", "dependabot_secrets", "codespaces_secrets", "agents_secrets"] as const
  ).map((key) => ({
    noun: "secret" as const,
    path: `${key}[0]`,
    doc: (entry: Record<string, unknown>) => ({ [key]: [{ value: "$TOKEN", ...entry }] }),
  })),
  ...(["actions_variables", "agents_variables"] as const).map((key) => ({
    noun: "variable" as const,
    path: `${key}[0]`,
    doc: (entry: Record<string, unknown>) => ({ [key]: [{ value: "on", ...entry }] }),
  })),
  {
    noun: "secret",
    path: "environments[0].secrets[0]",
    doc: (entry) => ({
      environments: [{ name: "prod", secrets: [{ value: "$TOKEN", ...entry }] }],
    }),
  },
  {
    noun: "variable",
    path: "environments[0].variables[0]",
    doc: (entry) => ({ environments: [{ name: "prod", variables: [{ value: "on", ...entry }] }] }),
  },
];

const VARIABLE_FAMILIES = FAMILIES.filter((family) => family.noun === "variable");

function issuesOf(doc: Record<string, unknown>): readonly string[] | "accepted" {
  const verdict = validateSectionShapes(doc, "settings.yml");
  return verdict.isErr() ? verdict.error.issues : "accepted";
}

const RULE =
  "GitHub accepts ASCII letters, digits, and underscores, not starting with a digit or with the reserved GITHUB_ prefix (in any case: names are stored uppercased)";

describe("secret and variable names", () => {
  // `github_token` folds to the reserved GITHUB_TOKEN because the API uppercases before it compares.
  const refused: ReadonlyArray<{ name: string; reason: string }> = [
    { name: "my-secret", reason: "has characters outside ASCII letters, digits, and underscore" },
    { name: "log level", reason: "has characters outside ASCII letters, digits, and underscore" },
    { name: "2_TOKEN", reason: "starts with a digit" },
    { name: "GITHUB_TOKEN", reason: "starts with the reserved GITHUB_ prefix" },
    { name: "github_token", reason: "starts with the reserved GITHUB_ prefix" },
    { name: "", reason: "is empty" },
  ];
  const accepted = ["DEPLOY_TOKEN", "deploy_token", "_private", "GITHUBX", "GITHUB", "a1"];

  test.each(FAMILIES)(
    "$path: a name GitHub would 422 on fails the parse naming the rule",
    (family) => {
      const outcomes = Object.fromEntries([
        ...refused.map(({ name }) => [name, issuesOf(family.doc({ name }))]),
        ...accepted.map((name) => [name, issuesOf(family.doc({ name }))]),
      ]);
      expect(outcomes).toEqual({
        ...Object.fromEntries(
          refused.map(({ name, reason }) => [
            name,
            [
              `${family.path}.name: the ${family.noun} name ${JSON.stringify(name)} ${reason} - ${RULE}`,
            ],
          ]),
        ),
        ...Object.fromEntries(accepted.map((name) => [name, "accepted"])),
      });
    },
  );
});

describe("variable values", () => {
  const cap = MAX_VARIABLE_VALUE_BYTES;

  test("GitHub caps a variable value at 48 KB", () => expect(cap).toBe(49152));

  // A CJK character is three UTF-8 bytes, so a row lands exactly on the cap or one character over it while its
  // character count stays far below the cap.
  const threeByte = "\u4e2d";
  const refused = (bytes: number, path: string) =>
    `${path}.value: the variable value is ${bytes} bytes of UTF-8; GitHub caps a variable at 48 KB (${cap} bytes). Shorten it, or move the content into a file the workflow reads`;

  test.each(VARIABLE_FAMILIES)(
    "$path: a value over GitHub's 48 KB cap fails the parse; the cap counts UTF-8 bytes, and a mapping never reaches the size check",
    (family) => {
      const outcomes = {
        asciiAtCap: issuesOf(family.doc({ name: "BIG", value: "a".repeat(cap) })),
        asciiOverCap: issuesOf(family.doc({ name: "BIG", value: "a".repeat(cap + 1) })),
        threeByteAtCap: issuesOf(family.doc({ name: "BIG", value: threeByte.repeat(cap / 3) })),
        threeByteOverCap: issuesOf(
          family.doc({ name: "BIG", value: threeByte.repeat(cap / 3 + 1) }),
        ),
        mapping: issuesOf(family.doc({ name: "BIG", value: { length: cap + 1 } })),
      };
      expect(outcomes).toEqual({
        asciiAtCap: "accepted",
        asciiOverCap: [refused(cap + 1, family.path)],
        threeByteAtCap: "accepted",
        threeByteOverCap: [refused(cap + 3, family.path)],
        mapping: [`${family.path}.value: Invalid input: expected string, received object`],
      });
    },
  );
});

describe("secret entry keys", () => {
  test("a key outside name and value is refused naming the entry, since the sealed PUT body carries nothing else", () => {
    expect(
      issuesOf({ actions_secrets: [{ name: "TOKEN", value: "$TOKEN", values: "x" }] }),
    ).toEqual([
      'actions_secrets[0] (name "TOKEN"): declares "values", which this section does not recognize (known keys: name, value) - the API body carries only the sealed value, so the key would silently do nothing. Fix the key name, or remove it',
    ]);
  });
});
