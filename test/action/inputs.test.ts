import { afterEach, describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { INPUT_DECLS, parseConfig, type RunConfig } from "../../src/action/inputs.js";
import type { Problem } from "../../src/problem.js";
import { SECTION_KEYS } from "../../src/schema.js";

/**
 * parseConfig() reads inputs from the INPUT_* environment (via
 * @actions/core), so each test clears every declared input, sets exactly
 * the env it needs, and the afterEach restores every touched key.
 */
const ENV_KEYS = [
  ...Object.keys(INPUT_DECLS).map((name) => `INPUT_${name.toUpperCase()}`),
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
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

/** Clears every declared input, then sets `base` and `inputs` (INPUT_ names, lowercase) in that order. */
function setInputs(base: Record<string, string>, inputs: Record<string, string>): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries({ ...base, ...inputs })) {
    process.env[`INPUT_${key.toUpperCase()}`] = value;
  }
}

/** A single-repo apply run's env, with `inputs` on top. */
function setEnv(inputs: Record<string, string>): void {
  setInputs({ token: "t", repository: "o/r" }, inputs);
}

/** A mode: merge run's env: no token anywhere, the two layers, the output path, plus `inputs`. */
function setMergeEnv(inputs: Record<string, string>): void {
  setInputs(
    { mode: "merge", "settings-file": "fleet.yml\nrepo.yml", "merged-file": "out/merged.yml" },
    inputs,
  );
}

function rejection(): Problem {
  return parseConfig().match(
    (config) => {
      throw new Error(`expected a rejection, got: ${JSON.stringify(config)}`);
    },
    (problem) => problem,
  );
}

/** The parsed config of an engine mode; a merge config or a rejection fails the test. */
function engineConfig(): Extract<RunConfig, { kind: "single" | "multi" }> {
  const config = parseConfig()._unsafeUnwrap();
  if (config.kind === "merge") {
    throw new Error(`expected an engine config, got: ${JSON.stringify(config)}`);
  }
  return config;
}

describe("required-sections x sections cross-validation", () => {
  test("rejects a required section excluded by the sections allowlist", () => {
    setEnv({ "required-sections": "labels", sections: "repository" });
    expect(rejection()).toEqual({
      code: "input-required-sections-excluded",
      excluded: ["labels"],
    });
  });

  test("names every excluded required section at once, and only those", () => {
    setEnv({ "required-sections": "labels,milestones,repository", sections: "repository" });
    expect(rejection()).toEqual({
      code: "input-required-sections-excluded",
      excluded: ["labels", "milestones"],
    });
  });

  test("accepts required sections inside the allowlist", () => {
    setEnv({ "required-sections": "labels", sections: "labels,repository" });
    // Accepted AND carried into the config: a parse that silently dropped
    // either set would otherwise pass.
    const config = engineConfig();
    expect([config.requiredSections, config.onlySections]).toEqual([
      new Set(["labels"]),
      new Set(["labels", "repository"]),
    ]);
  });

  test("an empty sections input restricts nothing, so any required section passes", () => {
    setEnv({ "required-sections": "labels" });
    const config = engineConfig();
    expect([config.requiredSections, config.onlySections]).toEqual([
      new Set(["labels"]),
      new Set(),
    ]);
  });

  test("unknown-name validation still wins over the cross-check, per input", () => {
    setEnv({ "required-sections": "nope", sections: "repository,typo" });
    expect(rejection()).toEqual({
      code: "input-unknown-sections",
      unknown: [
        { input: "required-sections", names: ["nope"] },
        { input: "sections", names: ["typo"] },
      ],
      known: SECTION_KEYS,
    });
  });
});

describe("the mode input", () => {
  test("an unsupported mode is rejected carrying every supported one and the default", () => {
    setEnv({ mode: "dry-run" });
    expect(rejection()).toEqual({
      code: "input-unsupported-value",
      input: "mode",
      value: "dry-run",
      noun: "mode",
      allowed: ["apply", "check", "merge"],
      fallback: "apply",
    });
  });

  test.each([
    ["layering", { layering: "replace" }, ["layering"]],
    ["merged-file", { "merged-file": "out.yml" }, ["merged-file"]],
    [
      "both merge-only inputs",
      { layering: "merge", "merged-file": "out.yml" },
      ["merged-file", "layering"],
    ],
  ] as const)("%s outside merge mode is rejected", (_case, inputs, named) => {
    setEnv({ mode: "check", ...inputs });
    expect(rejection()).toEqual({ code: "input-merge-only", inputs: named, mode: "check" });
  });

  const SEPARATOR_CASES = [
    ["a comma list", "a.yml,b.yml"],
    ["a newline list", "a.yml\nb.yml"],
    ["an empty list", ","],
    ["a trailing separator", "only.yml,"],
    ["a leading separator", ",only.yml"],
  ] as const;

  test.each(
    (["apply", "check"] as const).flatMap((mode) =>
      SEPARATOR_CASES.map(([label, value]) => [mode, label, value] as const),
    ),
  )("%s mode rejects a settings-file with %s rather than repairing it", (mode, _case, value) => {
    setEnv({ mode, "settings-file": value });
    expect(rejection()).toEqual({ code: "input-settings-file-is-list", value, mode });
  });

  test("a plain settings-file path is carried verbatim into the single-repo config", () => {
    setEnv({ "settings-file": "conf/only.yml" });
    expect(parseConfig()).toEqual(
      ok({
        token: "t",
        mode: "apply",
        onMissingPermission: "fail",
        requiredSections: new Set(),
        onlySections: new Set(),
        apiVersion: "2022-11-28",
        privateRepos: "redact",
        privateReport: "none",
        reportPublicKey: "",
        selfSlug: "",
        runUrl: "",
        kind: "single",
        repo: { owner: "o", name: "r", slug: "o/r" },
        settingsFile: "conf/only.yml",
      }),
    );
  });

  test("a repository that is not an owner/name slug is rejected with the value", () => {
    setEnv({ repository: "not-a-slug" });
    expect(rejection()).toEqual({ code: "input-repository-not-slug", value: "not-a-slug" });
  });
});

describe("mode: merge", () => {
  /** What the two-layer merge env parses to; the tests below vary one input around it. */
  const MERGE_CONFIG: Extract<RunConfig, { kind: "merge" }> = {
    kind: "merge",
    settingsFiles: ["fleet.yml", "repo.yml"],
    mergedFile: "out/merged.yml",
    layering: "merge",
  };

  test("parses without any token, carrying the ordered layers, the output path, and the layering", () => {
    setMergeEnv({ layering: "replace" });
    expect(parseConfig()).toEqual(ok({ ...MERGE_CONFIG, layering: "replace" }));
  });

  test("the layering input defaults to merge and a comma list of layers works too", () => {
    setMergeEnv({ "settings-file": " fleet.yml , team.yml ,repo.yml" });
    expect(parseConfig()).toEqual(
      ok({ ...MERGE_CONFIG, settingsFiles: ["fleet.yml", "team.yml", "repo.yml"] }),
    );
  });

  test("an empty layer list is rejected", () => {
    setMergeEnv({ "settings-file": "," });
    expect(rejection()).toEqual({ code: "input-settings-file-empty", value: "," });
  });

  test("a missing merged-file is rejected", () => {
    setMergeEnv({ "merged-file": "" });
    expect(rejection()).toEqual({ code: "input-merged-file-missing" });
  });

  test("a merged-file beside the layers but not among them is accepted", () => {
    setMergeEnv({ "merged-file": "./merged.yml" });
    expect(parseConfig()).toEqual(ok({ ...MERGE_CONFIG, mergedFile: "./merged.yml" }));
  });

  test("an unsupported layering is rejected", () => {
    setMergeEnv({ layering: "union" });
    expect(rejection()).toEqual({
      code: "input-unsupported-value",
      input: "layering",
      value: "union",
      noun: "layering",
      allowed: ["merge", "replace"],
      fallback: "merge",
    });
  });

  test.each([
    ["repository", { repository: "o/r" }, ["repository"]],
    ["repos", { repos: "o/a" }, ["repos"]],
    ["defaults-file", { "defaults-file": "defaults.yml" }, ["defaults-file"]],
    ["required-sections", { "required-sections": "labels" }, ["required-sections"]],
    ["a discovery filter", { forks: "exclude" }, ["forks"]],
    ["private-report", { "private-report": "issue" }, ["private-report"]],
    ["report-public-key", { "report-public-key": "age1x" }, ["report-public-key"]],
    ["sections: the allowlist belongs on the apply step", { sections: "labels" }, ["sections"]],
    ["on-missing-permission: warn", { "on-missing-permission": "warn" }, ["on-missing-permission"]],
    ["a custom api-version", { "api-version": "2099-01-01" }, ["api-version"]],
    ["private-repos: show", { "private-repos": "show" }, ["private-repos"]],
    [
      "several at once, every one named in declaration order",
      { repos: "o/a", "repos-dir": "repos", "private-report": "artifact" },
      ["repos", "repos-dir", "private-report"],
    ],
    [
      "a previously tolerated control beside an always-rejected one, both named",
      { repos: "o/a", sections: "labels", "api-version": "2099-01-01" },
      ["sections", "api-version", "repos"],
    ],
  ] as const)(
    "%s is rejected: a merge has no repository, API, report, or allowlist",
    (_case, inputs, named) => {
      setMergeEnv(inputs);
      expect(rejection()).toEqual({ code: "input-rejected-in-merge", inputs: named });
    },
  );

  test("every declared default passes: the runner supplies them whether or not the workflow set the input", () => {
    // Every input outside the merge env itself, at the exact value action.yml
    // declares (token's is the unresolved workflow expression; the runner
    // resolves it, which is why token is tolerated at any value).
    const defaults = Object.fromEntries(
      Object.entries(INPUT_DECLS)
        .filter(([name]) => !["mode", "settings-file", "merged-file"].includes(name))
        .map(([name, decl]) => [name, decl.default]),
    );
    setMergeEnv(defaults);
    expect(parseConfig()).toEqual(ok(MERGE_CONFIG));
  });

  test("token is tolerated and never carried: the config has no field to read it from", () => {
    setMergeEnv({ token: "ghp_stepwide" });
    process.env.GITHUB_TOKEN = "ghp_envwide";
    const parsed = parseConfig();
    expect(parsed).toEqual(ok(MERGE_CONFIG));
    expect(JSON.stringify(parsed)).not.toContain("ghp_");
  });
});
