import { afterEach, describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { parseActionConfig } from "../../src/action/inputs.js";
import { INPUT_DECLS, SectionSelection } from "../../src/index.js";

/**
 * The adapter reads INPUT_* through @actions/core and the GITHUB_* context
 * from the environment, so the test sets exactly that env and restores it.
 */
const ENV_KEYS = [
  ...Object.keys(INPUT_DECLS).map((name) => `INPUT_${name.toUpperCase()}`),
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_SERVER_URL",
  "GITHUB_RUN_ID",
];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("parseActionConfig", () => {
  test("reads the step's inputs and the GITHUB_* context; every unset input takes its declared default", () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env["INPUT_SETTINGS-FILE"] = "conf/only.yml";
    process.env.GITHUB_TOKEN = "t";
    process.env.GITHUB_REPOSITORY = "o/r";
    process.env.GITHUB_SERVER_URL = "https://github.com";
    process.env.GITHUB_RUN_ID = "42";
    expect(parseActionConfig()).toEqual(
      ok({
        kind: "single",
        token: "t",
        mode: INPUT_DECLS.mode.default,
        onMissingPermission: INPUT_DECLS["on-missing-permission"].default,
        sections: SectionSelection.ALL,
        apiVersion: INPUT_DECLS["api-version"].default,
        privateRepos: INPUT_DECLS["private-repos"].default,
        privateReport: INPUT_DECLS["private-report"].default,
        reportPublicKey: "",
        selfSlug: "o/r",
        runUrl: "https://github.com/o/r/actions/runs/42",
        repo: { owner: "o", name: "r", slug: "o/r" },
        settingsFile: "conf/only.yml",
      }),
    );
  });
});
