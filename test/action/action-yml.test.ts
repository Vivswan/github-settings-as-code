/** The generated regions of action.yml are covered by test/scripts/gen-action-docs.test.ts. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { OUTPUT_DECLS } from "../../src/action/io.js";
import { DEFAULT_DISCOVERY_FILTERS } from "../../src/discovery/discover.js";
import { REPO_RESULTS } from "../../src/engine/orchestrate.js";
import { MERGE_RESULT } from "../../src/flows/deliver.js";
import { FILTER_INPUTS, INPUT_DECLS, type InputDecl } from "../../src/flows/inputs.js";

const ROOT = join(import.meta.dir, "..", "..");

interface ActionYml {
  name: string;
  runs: { using?: string; main?: string };
}

const actionYml = parseYaml(readFileSync(join(ROOT, "action.yml"), "utf8")) as ActionYml;

describe("action.yml <-> README", () => {
  test("the marketplace display name matches the README H1", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const h1 = readme.match(/^# (.+)$/m)?.[1];
    expect(actionYml.name).toBe(h1 as string);
  });
});

describe("action.yml runtime", () => {
  test("runs.using is node24 and AGENTS.md documents the same runtime", () => {
    // Bumping the runtime changes what Node the built bundle must run on, so the change has to land here too.
    expect(actionYml.runs.using).toBe("node24");
    const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    expect(
      agents.includes(`(${actionYml.runs.using})`),
      `AGENTS.md must document the bundle runtime as (${actionYml.runs.using})`,
    ).toBe(true);
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
  test("the result description mentions every RepoResult value and the merge result", () => {
    // MERGE_RESULT is the one value outside REPO_RESULTS (a merge has no target).
    const missing = [...REPO_RESULTS, MERGE_RESULT].filter(
      (value) => !OUTPUT_DECLS.result.description.includes(value),
    );
    expect(
      missing,
      `the "result" output description omits result value(s): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
