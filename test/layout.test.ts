import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { SECTION_KEYS } from "../src/schema.js";
import { SECTIONS_TEST_ROOT } from "./e2e/schema.js";
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

  test(`${MIRROR}/ holds at least one section directory`, () => {
    const sectionDirs = entries.filter(
      (entry) => entry.isDirectory() && SECTION_KEYS.some((key) => key === entry.name),
    );
    expect(sectionDirs.map((entry) => entry.name)).not.toEqual([]);
  });

  test(`a file named after a section lives in ${MIRROR}/<key>/, never flat beside the directories`, () => {
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
