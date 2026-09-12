import { afterEach, describe, expect, test } from "bun:test";
import { INPUT_DECLS, type MergeConfig, parseConfig } from "../../src/action/inputs.js";
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

function rejection(): string {
  const parsed = parseConfig();
  if (!("error" in parsed)) {
    throw new Error(`expected a rejection, got: ${JSON.stringify(parsed.config)}`);
  }
  return parsed.error;
}

describe("required-sections x sections cross-validation", () => {
  test("rejects a required section excluded by the sections allowlist", () => {
    setEnv({ "required-sections": "labels", sections: "repository" });
    expect(rejection()).toBe(
      'the "required-sections" entry "labels" is excluded by the "sections" allowlist, so the run would pass without ever attempting it. Add it to the "sections" input, or remove it from "required-sections"',
    );
  });

  test("names every excluded required section at once", () => {
    setEnv({ "required-sections": "labels,milestones,repository", sections: "repository" });
    const error = rejection();
    expect(error).toContain('entries "labels", "milestones" are excluded');
    expect(error).not.toContain('"repository"');
  });

  test("accepts required sections inside the allowlist", () => {
    setEnv({ "required-sections": "labels", sections: "labels,repository" });
    const parsed = parseConfig();
    if ("error" in parsed || parsed.config.kind === "merge") {
      throw new Error(`expected a single-repo config, got: ${JSON.stringify(parsed)}`);
    }
    // Accepted AND carried into the config: a parse that silently dropped
    // either set would otherwise pass.
    expect([parsed.config.requiredSections, parsed.config.onlySections]).toEqual([
      new Set(["labels"]),
      new Set(["labels", "repository"]),
    ]);
  });

  test("an empty sections input restricts nothing, so any required section passes", () => {
    setEnv({ "required-sections": "labels" });
    const parsed = parseConfig();
    if ("error" in parsed || parsed.config.kind === "merge") {
      throw new Error(`expected a single-repo config, got: ${JSON.stringify(parsed)}`);
    }
    expect([parsed.config.requiredSections, parsed.config.onlySections]).toEqual([
      new Set(["labels"]),
      new Set(),
    ]);
  });

  test("unknown-name validation still wins over the cross-check", () => {
    setEnv({ "required-sections": "nope", sections: "repository" });
    expect(rejection()).toBe(
      `unknown section "nope" in the "required-sections" input; it matches none of: ${SECTION_KEYS.join(", ")}. Fix the name in the workflow's input list`,
    );
  });
});

describe("the mode input", () => {
  test("an unsupported mode is rejected naming every supported one", () => {
    setEnv({ mode: "dry-run" });
    expect(rejection()).toBe(
      'the "mode" input is "dry-run", which is not a supported mode. Set it to "apply" (default), "check", "merge"',
    );
  });

  test.each([
    ["layering", { layering: "replace" }, 'the "layering" input(s) only apply to mode: merge'],
    [
      "merged-file",
      { "merged-file": "out.yml" },
      'the "merged-file" input(s) only apply to mode: merge',
    ],
    [
      "both merge-only inputs",
      { layering: "merge", "merged-file": "out.yml" },
      'the "merged-file", "layering" input(s) only apply to mode: merge, but this run is in check mode, so they would never be used',
    ],
  ] as const)("%s outside merge mode is rejected", (_case, inputs, fragment) => {
    setEnv({ mode: "check", ...inputs });
    expect(rejection()).toContain(fragment);
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
    expect(rejection()).toBe(
      `the "settings-file" input is "${value}", which contains a list separator: ${mode} mode ` +
        `reads exactly one settings file, and only mode: merge takes a newline- or ` +
        `comma-separated list. Name one file, or set mode: merge to fold the list into one ` +
        `document`,
    );
  });

  test("a plain settings-file path is carried verbatim into the single-repo config", () => {
    setEnv({ "settings-file": "conf/only.yml" });
    expect(parseConfig()).toEqual({
      config: {
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
      },
    });
  });
});

describe("mode: merge", () => {
  /** What the two-layer merge env parses to; the tests below vary one input around it. */
  const MERGE_CONFIG: MergeConfig = {
    kind: "merge",
    settingsFiles: ["fleet.yml", "repo.yml"],
    mergedFile: "out/merged.yml",
    layering: "merge",
  };

  test("parses without any token, carrying the ordered layers, the output path, and the layering", () => {
    setMergeEnv({ layering: "replace" });
    expect(parseConfig()).toEqual({ config: { ...MERGE_CONFIG, layering: "replace" } });
  });

  test("the layering input defaults to merge and a comma list of layers works too", () => {
    setMergeEnv({ "settings-file": " fleet.yml , team.yml ,repo.yml" });
    expect(parseConfig()).toEqual({
      config: { ...MERGE_CONFIG, settingsFiles: ["fleet.yml", "team.yml", "repo.yml"] },
    });
  });

  test("an empty layer list is rejected", () => {
    setMergeEnv({ "settings-file": "," });
    expect(rejection()).toBe(
      'the "settings-file" input is ",", which lists no file. In mode: merge it is the ordered list of layers to fold, newline- or comma-separated, lowest first; name at least one settings file',
    );
  });

  test("a missing merged-file is rejected", () => {
    setMergeEnv({ "merged-file": "" });
    expect(rejection()).toBe(
      'mode: merge needs a "merged-file" input: the path the merged settings document is written to. Set it (for example .github/settings.merged.yml) and feed that path to a later apply or check step as its settings-file',
    );
  });

  test("a merged-file that names one of the layers is rejected, naming the layer's position", () => {
    setMergeEnv({ "merged-file": "repo.yml" });
    expect(rejection()).toBe(
      'the "merged-file" input "repo.yml" is layer 2 of the "settings-file" list ("repo.yml"): ' +
        "the merge would overwrite that layer with the folded document, and the next run would " +
        "fold the merged document as a layer. Write the merged document to a path outside the " +
        "layer list",
    );
  });

  test("the collision is found on the resolved paths, so a ./ spelling of a layer still collides", () => {
    setMergeEnv({ "merged-file": "./fleet.yml" });
    expect(rejection()).toBe(
      'the "merged-file" input "./fleet.yml" is layer 1 of the "settings-file" list ' +
        '("fleet.yml"): the merge would overwrite that layer with the folded document, and the ' +
        "next run would fold the merged document as a layer. Write the merged document to a path " +
        "outside the layer list",
    );
  });

  test("a merged-file beside the layers but not among them is accepted", () => {
    setMergeEnv({ "merged-file": "./merged.yml" });
    expect(parseConfig()).toEqual({ config: { ...MERGE_CONFIG, mergedFile: "./merged.yml" } });
  });

  test("an unsupported layering is rejected", () => {
    setMergeEnv({ layering: "union" });
    expect(rejection()).toBe(
      'the "layering" input is "union", which is not a supported layering. Set it to "merge" (default), "replace"',
    );
  });

  test.each([
    ["repository", { repository: "o/r" }, '"repository"'],
    ["repos", { repos: "o/a" }, '"repos"'],
    ["defaults-file", { "defaults-file": "defaults.yml" }, '"defaults-file"'],
    ["required-sections", { "required-sections": "labels" }, '"required-sections"'],
    ["a discovery filter", { forks: "exclude" }, '"forks"'],
    ["private-report", { "private-report": "issue" }, '"private-report"'],
    ["report-public-key", { "report-public-key": "age1x" }, '"report-public-key"'],
    ["sections: the allowlist belongs on the apply step", { sections: "labels" }, '"sections"'],
    ["on-missing-permission: warn", { "on-missing-permission": "warn" }, '"on-missing-permission"'],
    ["a custom api-version", { "api-version": "2099-01-01" }, '"api-version"'],
    ["private-repos: show", { "private-repos": "show" }, '"private-repos"'],
    [
      "several at once, every one named in declaration order",
      { repos: "o/a", "repos-dir": "repos", "private-report": "artifact" },
      '"repos", "repos-dir", "private-report"',
    ],
    [
      "a previously tolerated control beside an always-rejected one, both named",
      { repos: "o/a", sections: "labels", "api-version": "2099-01-01" },
      '"sections", "api-version", "repos"',
    ],
  ] as const)(
    "%s is rejected: a merge has no repository, API, report, or allowlist",
    (_case, inputs, named) => {
      setMergeEnv(inputs);
      expect(rejection()).toBe(
        `the ${named} input(s) do not apply to mode: merge, which only folds the settings-file ` +
          `layers into merged-file: it never targets a repository, calls the GitHub API, ` +
          `delivers a report, or narrows the sections it writes. Remove the input(s), or move ` +
          `them to the apply or check step that runs the merged document`,
      );
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
    expect(parseConfig()).toEqual({ config: MERGE_CONFIG });
  });

  test("token is tolerated and never carried: the config has no field to read it from", () => {
    setMergeEnv({ token: "ghp_stepwide" });
    process.env.GITHUB_TOKEN = "ghp_envwide";
    const parsed = parseConfig();
    expect(parsed).toEqual({ config: MERGE_CONFIG });
    expect(JSON.stringify(parsed)).not.toContain("ghp_");
  });
});
