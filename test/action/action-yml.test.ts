/**
 * action.yml's hand-written half (name, runtime) and the input/output
 * declarations its generated half renders from; the generated regions
 * themselves are covered by test/scripts/gen-action-docs.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  FILTER_INPUTS,
  INPUT_DECLS,
  type InputDecl,
  parseConfig,
} from "../../src/action/inputs.js";
import { OUTPUT_DECLS } from "../../src/action/io.js";
import { DEFAULT_DISCOVERY_FILTERS } from "../../src/discovery/discover.js";
import { REPO_RESULTS } from "../../src/engine/orchestrate.js";

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
    // The runtime is a conscious pin: bumping it changes what Node the
    // built bundle must run on, so the change has to land here too.
    expect(actionYml.runs.using).toBe("node24");
    // AGENTS.md tells agents which runtime the bundle targets; it must name
    // the one action.yml declares.
    const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    expect(
      agents.includes(`(${actionYml.runs.using})`),
      `AGENTS.md must document the bundle runtime as (${actionYml.runs.using})`,
    ).toBe(true);
  });
});

describe("input declarations <-> discovery defaults", () => {
  test("each discovery filter declares an empty default and shows its effective one", () => {
    // A filter is "explicitly set" when its raw input is not "", so a
    // non-empty declared default would defeat that detection; the README
    // shows the effective default instead and the description names it.
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
      expect(decl.shownDefault, `the README must show "${name}" defaulting to ${value}`).toBe(
        `\`${value}\``,
      );
    }
  });
});

describe("output declarations", () => {
  test("the result description mentions every RepoResult value", () => {
    // REPO_RESULTS is the canonical value list exported next to worstOf() in
    // src/engine/orchestrate.ts; a new RepoResult value added there but left
    // out of the output docs fails here.
    const missing = REPO_RESULTS.filter(
      (value) => !OUTPUT_DECLS.result.description.includes(value),
    );
    expect(
      missing,
      `the "result" output description omits RepoResult value(s): ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

describe("parseConfig <-> input declarations", () => {
  // Every env key the parse reads: the INPUT_* the runner would set from
  // action.yml (@actions/core keeps the dashes) and the GITHUB_* context.
  const touched = [
    ...Object.keys(INPUT_DECLS).map((name) => `INPUT_${name.toUpperCase()}`),
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_SERVER_URL",
    "GITHUB_RUN_ID",
  ];
  const saved = new Map(touched.map((key) => [key, process.env[key]]));
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("every unset input resolves to its declared default", () => {
    for (const key of touched) {
      delete process.env[key];
    }
    process.env.INPUT_TOKEN = "t";
    process.env.GITHUB_REPOSITORY = "o/r";
    const parsed = parseConfig();
    if ("error" in parsed) {
      throw new Error(`expected a config, got: ${parsed.error}`);
    }
    expect(parsed.config).toEqual({
      kind: "single",
      token: "t",
      mode: INPUT_DECLS.mode.default,
      onMissingPermission: INPUT_DECLS["on-missing-permission"].default,
      requiredSections: new Set(),
      onlySections: new Set(),
      apiVersion: INPUT_DECLS["api-version"].default,
      privateRepos: INPUT_DECLS["private-repos"].default,
      privateReport: INPUT_DECLS["private-report"].default,
      reportPublicKey: "",
      selfSlug: "o/r",
      runUrl: "",
      repo: { owner: "o", name: "r", slug: "o/r" },
      settingsFile: INPUT_DECLS["settings-file"].default,
    });
  });
});
