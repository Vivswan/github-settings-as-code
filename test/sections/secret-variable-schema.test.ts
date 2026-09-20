/**
 * GitHub's rules for secret and variable names and for a variable value's size are enforced by the API alone, as a
 * 422 in the middle of an apply; these pin that every family refuses them when the file is parsed, on the rendered
 * problem line a user reads.
 */

import { describe, expect, test } from "bun:test";
import { validateSectionShapes } from "../../src/engine/validate.js";

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
  // GitHub's documented cap, spelled here independently of the source so a moved constant fails this test.
  const cap = 49152;

  test.each(VARIABLE_FAMILIES)(
    "$path: a value over GitHub's 48 KB cap fails the parse; the cap counts code points, and a mapping never reaches the length check",
    (family) => {
      // The emoji string is twice the cap in UTF-16 units and exactly the cap in code points.
      const outcomes = {
        atCap: issuesOf(family.doc({ name: "BIG", value: "a".repeat(cap) })),
        overCap: issuesOf(family.doc({ name: "BIG", value: "a".repeat(cap + 1) })),
        astralAtCap: issuesOf(family.doc({ name: "BIG", value: "\u{1F600}".repeat(cap) })),
        mapping: issuesOf(family.doc({ name: "BIG", value: { length: cap + 1 } })),
      };
      expect(outcomes).toEqual({
        atCap: "accepted",
        overCap: [
          `${family.path}.value: the variable value is ${cap + 1} characters long; GitHub caps a variable at 48 KB (${cap} characters). Shorten it, or move the content into a file the workflow reads`,
        ],
        astralAtCap: "accepted",
        mapping: [`${family.path}.value: Invalid input: expected string, received object`],
      });
    },
  );
});
