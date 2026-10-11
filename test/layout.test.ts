// tier: pr
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { SECTION_KEYS } from "../src/schema.js";
import { SECTIONS_TEST_ROOT } from "./e2e/scenario.js";
import { ROOT } from "./root.js";

/** The mirror root as the messages name it, e.g. test/sections. */
const MIRROR = relative(ROOT, SECTIONS_TEST_ROOT);

/** labels.test.ts and labels-schema.test.ts, but not list-section.test.ts: the stem is a key or its dashed slug,
 * alone or before a dash or underscore. */
function isSectionNamedFile(name: string): boolean {
  const stem = name.split(".")[0] ?? "";
  return SECTION_KEYS.some((key) => {
    const slug = key.replaceAll("_", "-");
    return [key, slug].some(
      (spelling) =>
        stem === spelling || stem.startsWith(`${spelling}-`) || stem.startsWith(`${spelling}_`),
    );
  });
}

describe("repository layout", () => {
  test("src/ holds code only: no test, mock, generator, scenario, or docs prose lives under it", () => {
    const strays = readdirSync(join(ROOT, "src"), { recursive: true, encoding: "utf8" }).filter(
      (entry) =>
        entry.endsWith(".test.ts") ||
        ["mock.ts", "generators.ts"].includes(basename(entry)) ||
        entry.endsWith(".docs.yml") ||
        entry.split("/").includes("scenarios"),
    );
    expect(
      strays.map((entry) => `src/${entry}`),
      `move these under ${MIRROR}/`,
    ).toEqual([]);
  });

  // readdirSync throws on a missing root, so a mirror that moved without moving the constant fails here by path.
  const entries = readdirSync(SECTIONS_TEST_ROOT, { withFileTypes: true });

  test(`a file named after a section lives in ${MIRROR}/<key>/, never flat beside the directories`, () => {
    // The guard against a vacuous pass: a mirror root with no section directory is not the mirror this test reads.
    const sectionDirs = entries.filter(
      (entry) => entry.isDirectory() && SECTION_KEYS.some((key) => key === entry.name),
    );
    expect(
      sectionDirs.map((entry) => entry.name),
      `${MIRROR}/ holds no section directory`,
    ).not.toEqual([]);
    const strays = entries
      .filter((entry) => entry.isFile() && isSectionNamedFile(entry.name))
      .map((entry) => `${MIRROR}/${entry.name}`);
    expect(strays, "move each into its section's directory").toEqual([]);
  });

  test.each<[string, boolean]>([
    ["labels.test.ts", true],
    ["labels-schema.test.ts", true],
    ["labels_schema.test.ts", true],
    ["secret-scanning-custom-patterns-schema.test.ts", true],
    ["actions_secrets.ts", true],
    ["interaction_limits_schema.test.ts", true],
    ["list-section.test.ts", false],
    ["secret-variable-schema.test.ts", false],
    ["labelsx.test.ts", false],
  ])("%s is named after a section: %p", (name, named) => {
    expect(isSectionNamedFile(name)).toBe(named);
  });
});

const TIER_LINE = /^\/\/ tier: (pr|release-gate|nightly)$/;

/**
 * The fleet's tier census (the code-standards tests section): every test file's first line names when it runs.
 * Here the runner fixes the answer: checks.yml's `bun run test` is bun test over the whole tree on every PR, so a
 * `.test.ts` file is `pr` by construction, and one claiming another tier would still run on every merge. The
 * release-gate tier is script-driven (release-gate.yml runs fuzz.ts and the probe), not a test file; a release-gate
 * test file needs the pr run narrowed first, and this census rewritten for the new layout.
 */
function tierProblems(files: ReadonlyArray<[path: string, firstLine: string]>): string[] {
  return files.flatMap(([path, firstLine]) => {
    const tier = TIER_LINE.exec(firstLine)?.[1];
    if (tier === undefined) return [`${path}: first line is not "// tier: pr"`];
    if (tier !== "pr") {
      return [
        `${path}: tier ${tier}, but bun test runs it on every PR; narrow the pr run before naming another tier`,
      ];
    }
    return [];
  });
}

describe("test tiers", () => {
  const testFiles = readdirSync(join(ROOT, "test"), { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".test.ts"))
    .sort()
    .map((entry): [string, string] => [
      `test/${entry}`,
      readFileSync(join(ROOT, "test", entry), "utf8").split("\n", 1)[0] ?? "",
    ]);

  test("every test file's first line names its tier, and the tier is the one the workflows run it under", () => {
    expect(testFiles.length).toBeGreaterThan(100);
    expect(tierProblems(testFiles)).toEqual([]);
  });

  test.each<[string, string, RegExp]>([
    ["no marker", 'import { test } from "bun:test";', /first line is not/],
    ["a misspelled tier", "// tier: PR", /first line is not/],
    ["the marker on the second line", "\n// tier: pr", /first line is not/],
    ["a tier the pr run would still carry", "// tier: release-gate", /runs it on every PR/],
  ])("%s fails the census (negative control)", (_case, firstLine, failure) => {
    expect(
      tierProblems([["test/x.test.ts", firstLine.split("\n", 1)[0] ?? ""]]).join("\n"),
    ).toMatch(failure);
  });
});
