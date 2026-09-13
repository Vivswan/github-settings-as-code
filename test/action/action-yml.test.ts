/** The generated regions of action.yml are covered by test/scripts/gen-action-docs.test.ts. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { OUTPUT_DECLS } from "../../src/action/io.js";
import { DEFAULT_DISCOVERY_FILTERS } from "../../src/discovery/discover.js";
import { RUN_RESULTS } from "../../src/engine/outcome.js";
import { FILTER_INPUTS, INPUT_DECLS, type InputDecl } from "../../src/flows/inputs.js";

const ROOT = join(import.meta.dir, "..", "..");

interface ActionYml {
  name: string;
}

const actionYml = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8")) as ActionYml;

describe("action.yml <-> README", () => {
  test("the marketplace display name matches the README H1", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const h1 = readme.match(/^# (.+)$/m)?.[1];
    expect(actionYml.name).toBe(h1 as string);
  });
});

describe("input declarations <-> discovery defaults", () => {
  test("each discovery filter declares an empty default and shows its effective one", () => {
    // A filter is "explicitly set" when its raw input is not "", so a non-empty declared default would defeat that detection.
    const effective: Partial<Record<(typeof FILTER_INPUTS)[number], string>> = {
      visibility: DEFAULT_DISCOVERY_FILTERS.visibility,
      archived: DEFAULT_DISCOVERY_FILTERS.archived,
      forks: DEFAULT_DISCOVERY_FILTERS.forks,
      affiliation: DEFAULT_DISCOVERY_FILTERS.affiliation.join(","),
    };
    for (const name of FILTER_INPUTS) {
      const decl: InputDecl = INPUT_DECLS[name];
      expect(decl.default, `the "${name}" declaration must default to ""`).toBe("");
      const value = effective[name];
      if (value === undefined) {
        expect(decl.shownDefault, `"${name}" has no effective default to show`).toBeUndefined();
        continue;
      }
      expect(
        decl.description.includes(value),
        `the "${name}" description does not mention its default "${value}"`,
      ).toBe(true);
      expect(decl.shownDefault, `the Inputs table must show "${name}" defaulting to ${value}`).toBe(
        `\`${value}\``,
      );
    }
  });
});

describe("output declarations", () => {
  test("the result description enumerates exactly the RUN_RESULTS words, worst first, and states the exit rule", () => {
    // The enumerated values are the `a | b | c` chain; a value named only in prose does not count.
    const { description } = OUTPUT_DECLS.result;
    const [chain, ...more] = description.match(/[a-z]+(?: \| [a-z]+)+/g) ?? [];
    expect(more).toEqual([]);
    expect(chain?.split(" | ")).toEqual([...RUN_RESULTS]);
    expect(description).toContain("Exit 1 exactly when it is failed, or drift in mode: check");
  });

  test("the repos-result description spells the body keys as the outputs spell theirs, and names the empty map", () => {
    const { description } = OUTPUT_DECLS["repos-result"];
    expect(description).toContain("{result, source, skipped-sections}");
    expect(description).not.toContain("skippedSections");
    expect(description).toContain("The empty map {} for a run over one repository or a merge");
  });
});
