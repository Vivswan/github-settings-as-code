import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import {
  type ConfigEnv,
  DEFAULT_DISCOVERY_FILTERS,
  INPUT_DECLS,
  type InputName,
  type Problem,
  parseConfig,
  type RunConfig,
  SECTION_KEYS,
  SectionSelection,
  SNAPSHOT_REJECTED_INPUTS,
} from "../../src/index.js";

/** Parse a step's inputs (unset ones read as empty, as the runner reports them) under `env`. */
function parse(inputs: Partial<Record<InputName, string>>, env: ConfigEnv = {}) {
  return parseConfig((name) => inputs[name] ?? "", env);
}

/** A single-repo apply run's inputs, with `inputs` on top. */
function single(inputs: Partial<Record<InputName, string>>, env: ConfigEnv = {}) {
  return parse({ token: "t", repository: "o/r", ...inputs }, env);
}

/** A mode: merge run's inputs: no token anywhere, the two layers, the output path, plus `inputs`. */
function merge(inputs: Partial<Record<InputName, string>>) {
  return parse({
    mode: "merge",
    "settings-file": "fleet.yml\nrepo.yml",
    "merged-file": "out/merged.yml",
    ...inputs,
  });
}

function rejection(parsed: ReturnType<typeof parseConfig>): Problem {
  return parsed.match(
    (config) => {
      throw new Error(`expected a rejection, got: ${JSON.stringify(config)}`);
    },
    (problem) => problem,
  );
}

/** The parsed config of an engine mode; a merge config or a rejection fails the test. */
function engineConfig(
  parsed: ReturnType<typeof parseConfig>,
): Extract<RunConfig, { kind: "single" | "multi" }> {
  const config = parsed._unsafeUnwrap();
  if (config.kind === "merge" || config.kind === "snapshot") {
    throw new Error(`expected an engine config, got: ${JSON.stringify(config)}`);
  }
  return config;
}

/** A mode: snapshot run's inputs: the token, the mode, and `inputs` (one destination among them). */
function snapshot(inputs: Partial<Record<InputName, string>>, env: ConfigEnv = {}) {
  return parse({ token: "t", mode: "snapshot", ...inputs }, env);
}

describe("the declared defaults", () => {
  test("every unset input resolves to its declared default; the GITHUB_* context fills the rest", () => {
    expect(
      parse(
        {},
        {
          GITHUB_TOKEN: "t",
          GITHUB_REPOSITORY: "o/r",
          GITHUB_SERVER_URL: "https://ghe.test",
          GITHUB_RUN_ID: "7",
        },
      ),
    ).toEqual(
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
        runUrl: "https://ghe.test/o/r/actions/runs/7",
        repo: { owner: "o", name: "r", slug: "o/r" },
        settingsFile: INPUT_DECLS["settings-file"].default,
      }),
    );
  });

  test("the token input wins over GITHUB_TOKEN, and no token anywhere is the problem", () => {
    expect(engineConfig(single({}, { GITHUB_TOKEN: "env" })).token).toBe("t");
    expect(rejection(parse({ repository: "o/r" }))).toEqual({ code: "input-token-missing" });
  });

  test("every input is trimmed, so a whitespace-only token is unset and the env token applies", () => {
    const config = engineConfig(
      parse(
        { token: "  ", repository: " o/r ", "settings-file": " conf/only.yml " },
        {
          GITHUB_TOKEN: "env",
        },
      ),
    );
    expect([
      config.token,
      config.kind === "single" ? config.repo.slug : "",
      config.kind === "single" ? config.settingsFile : "",
    ]).toEqual(["env", "o/r", "conf/only.yml"]);
  });
});

describe("required-sections x sections cross-validation", () => {
  test("rejects a required section excluded by the sections allowlist", () => {
    expect(rejection(single({ "required-sections": "labels", sections: "repository" }))).toEqual({
      code: "required-sections-excluded",
      excluded: ["labels"],
    });
  });

  test("names every excluded required section at once, and only those", () => {
    expect(
      rejection(
        single({ "required-sections": "labels,milestones,repository", sections: "repository" }),
      ),
    ).toEqual({ code: "required-sections-excluded", excluded: ["labels", "milestones"] });
  });

  test("accepts required sections inside the allowlist, carried as the validated selection", () => {
    // Accepted AND carried into the config: a parse that silently dropped
    // either set would otherwise pass.
    expect(
      engineConfig(single({ "required-sections": "labels", sections: "labels,repository" }))
        .sections,
    ).toEqual(
      SectionSelection.of({ only: ["labels", "repository"], required: ["labels"] })._unsafeUnwrap(),
    );
  });

  test("an empty sections input restricts nothing, so any required section passes", () => {
    expect(engineConfig(single({ "required-sections": "labels" })).sections).toEqual(
      SectionSelection.of({ required: ["labels"] })._unsafeUnwrap(),
    );
  });

  test("unknown-name validation still wins over the cross-check, per input", () => {
    expect(rejection(single({ "required-sections": "nope", sections: "repository,typo" }))).toEqual(
      {
        code: "input-unknown-sections",
        unknown: [
          { input: "required-sections", names: ["nope"] },
          { input: "sections", names: ["typo"] },
        ],
        known: SECTION_KEYS,
      },
    );
  });
});

describe("the mode input", () => {
  test("an unsupported mode is rejected carrying every supported one and the default", () => {
    expect(rejection(single({ mode: "dry-run" }))).toEqual({
      code: "input-unsupported-value",
      input: "mode",
      value: "dry-run",
      noun: "mode",
      allowed: ["apply", "check", "merge", "snapshot"],
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
    expect(rejection(single({ mode: "check", ...inputs }))).toEqual({
      code: "input-merge-only",
      inputs: named,
      mode: "check",
    });
  });

  test.each([
    ["snapshot-file", { "snapshot-file": "snap.yml" }, ["snapshot-file"]],
    ["snapshot-dir", { "snapshot-dir": "snapshots" }, ["snapshot-dir"]],
    [
      "both snapshot-only inputs",
      { "snapshot-file": "snap.yml", "snapshot-dir": "snapshots" },
      ["snapshot-file", "snapshot-dir"],
    ],
  ] as const)("%s outside snapshot mode is rejected", (_case, inputs, named) => {
    expect(rejection(single({ mode: "check", ...inputs }))).toEqual({
      code: "input-snapshot-only",
      inputs: named,
      mode: "check",
    });
  });

  test("a merge-only input set beside a snapshot-only one is reported first: the first problem wins", () => {
    expect(
      rejection(single({ mode: "check", "merged-file": "out.yml", "snapshot-dir": "snapshots" })),
    ).toEqual({ code: "input-merge-only", inputs: ["merged-file"], mode: "check" });
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
    expect(rejection(single({ mode, "settings-file": value }))).toEqual({
      code: "input-settings-file-is-list",
      value,
      mode,
    });
  });

  test("a plain settings-file path is carried verbatim into the single-repo config", () => {
    expect(single({ "settings-file": "conf/only.yml" })).toEqual(
      ok({
        token: "t",
        mode: "apply",
        onMissingPermission: "fail",
        sections: SectionSelection.ALL,
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
    expect(rejection(single({ repository: "not-a-slug" }))).toEqual({
      code: "input-repository-not-slug",
      value: "not-a-slug",
    });
  });
});

describe("mode: merge", () => {
  /** What the two-layer merge inputs parse to; the tests below vary one input around it. */
  const MERGE_CONFIG: Extract<RunConfig, { kind: "merge" }> = {
    kind: "merge",
    settingsFiles: ["fleet.yml", "repo.yml"],
    mergedFile: "out/merged.yml",
    layering: "merge",
  };

  test("parses without any token, carrying the ordered layers, the output path, and the layering", () => {
    expect(merge({ layering: "replace" })).toEqual(ok({ ...MERGE_CONFIG, layering: "replace" }));
  });

  test("the layering input defaults to merge and a comma list of layers works too", () => {
    expect(merge({ "settings-file": " fleet.yml , team.yml ,repo.yml" })).toEqual(
      ok({ ...MERGE_CONFIG, settingsFiles: ["fleet.yml", "team.yml", "repo.yml"] }),
    );
  });

  test("an empty layer list is rejected", () => {
    expect(rejection(merge({ "settings-file": "," }))).toEqual({
      code: "input-settings-file-empty",
      value: ",",
    });
  });

  test("a missing merged-file is rejected", () => {
    expect(rejection(merge({ "merged-file": "" }))).toEqual({ code: "input-merged-file-missing" });
  });

  test("a merged-file beside the layers is accepted; the collision with a layer is the fold's to refuse", () => {
    expect(merge({ "merged-file": "./merged.yml" })).toEqual(
      ok({ ...MERGE_CONFIG, mergedFile: "./merged.yml" }),
    );
  });

  test("an unsupported layering is rejected", () => {
    expect(rejection(merge({ layering: "union" }))).toEqual({
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
      expect(rejection(merge(inputs))).toEqual({ code: "input-rejected-in-merge", inputs: named });
    },
  );

  test("every declared default passes: the runner supplies them whether or not the workflow set the input", () => {
    // Every input outside the merge inputs themselves, at the exact value
    // action.yml declares (token's is the unresolved workflow expression; the
    // runner resolves it, which is why token is tolerated at any value).
    const defaults = Object.fromEntries(
      Object.entries(INPUT_DECLS)
        .filter(([name]) => !["mode", "settings-file", "merged-file"].includes(name))
        .map(([name, decl]) => [name, decl.default]),
    );
    expect(merge(defaults)).toEqual(ok(MERGE_CONFIG));
  });

  test("token is tolerated and never carried: the config has no field to read it from", () => {
    const parsed = parse(
      {
        mode: "merge",
        "settings-file": "fleet.yml\nrepo.yml",
        "merged-file": "out/merged.yml",
        token: "ghp_stepwide",
      },
      { GITHUB_TOKEN: "ghp_envwide" },
    );
    expect(parsed).toEqual(ok(MERGE_CONFIG));
    expect(JSON.stringify(parsed)).not.toContain("ghp_");
  });
});

describe("mode: snapshot", () => {
  const SHARED = {
    kind: "snapshot",
    token: "t",
    apiVersion: "2022-11-28",
    onMissingPermission: "fail",
    sections: SectionSelection.ALL,
    privateRepos: "redact",
    selfSlug: "",
  } as const;

  test("the file form targets the repository input and carries the selection and policies", () => {
    expect(
      snapshot({
        repository: "o/r",
        "snapshot-file": "out/snapshot.yml",
        sections: "labels,webhooks",
        "on-missing-permission": "warn",
        "private-repos": "show",
      }),
    ).toEqual(
      ok({
        ...SHARED,
        sections: SectionSelection.of({ only: ["labels", "webhooks"] })._unsafeUnwrap(),
        onMissingPermission: "warn",
        privateRepos: "show",
        form: "file",
        repo: { owner: "o", name: "r", slug: "o/r" },
        snapshotFile: "out/snapshot.yml",
      }),
    );
  });

  test("the file form falls back to GITHUB_REPOSITORY, which is also the self slug", () => {
    expect(
      snapshot({ "snapshot-file": "snapshot.yml" }, { GITHUB_REPOSITORY: "self/repo" }),
    ).toEqual(
      ok({
        ...SHARED,
        selfSlug: "self/repo",
        form: "file",
        repo: { owner: "self", name: "repo", slug: "self/repo" },
        snapshotFile: "snapshot.yml",
      }),
    );
  });

  test("the dir form carries the multi-repo target inputs, discovery filters included", () => {
    expect(
      snapshot(
        {
          "snapshot-dir": "repos-snapshots",
          repos: "*",
          "repos-dir": "repos",
          forks: "exclude",
          topics: "Team-A",
        },
        { GITHUB_REPOSITORY: "admin/fleet" },
      ),
    ).toEqual(
      ok({
        ...SHARED,
        selfSlug: "admin/fleet",
        form: "dir",
        snapshotDir: "repos-snapshots",
        reposInput: "*",
        reposDir: "repos",
        adminOwner: "admin",
        discoveryFilters: { ...DEFAULT_DISCOVERY_FILTERS, forks: "exclude", topics: ["team-a"] },
        discoveryFiltersSet: ["forks", "topics"],
      }),
    );
  });

  test.each([
    ["neither destination", {}, { code: "input-snapshot-destination-missing" }],
    [
      "both destinations",
      { "snapshot-file": "snap.yml", "snapshot-dir": "snapshots" },
      { code: "input-snapshot-destinations-both" },
    ],
    [
      "snapshot-file beside repos",
      { "snapshot-file": "snap.yml", repos: "o/a" },
      { code: "input-snapshot-file-with-multi" },
    ],
    [
      "snapshot-file beside a discovery filter",
      { "snapshot-file": "snap.yml", repository: "o/r", forks: "only" },
      { code: "discovery-filters-without-wildcard", filters: ["forks"], targets: "snapshot-file" },
    ],
    [
      "snapshot-file without any repository to target",
      { "snapshot-file": "snap.yml" },
      { code: "input-repository-not-slug", value: "" },
    ],
    [
      "snapshot-dir beside repository",
      { "snapshot-dir": "snapshots", repository: "o/r", repos: "o/a" },
      { code: "input-repository-with-snapshot-dir" },
    ],
    [
      "snapshot-dir without targets",
      { "snapshot-dir": "snapshots" },
      { code: "input-snapshot-dir-without-targets" },
    ],
    [
      "an invalid discovery filter in the dir form",
      { "snapshot-dir": "snapshots", repos: "*", archived: "maybe" },
      {
        code: "input-unsupported-value",
        input: "archived",
        value: "maybe",
        noun: "archived-repository policy",
        allowed: ["skip", "include", "only"],
        fallback: "skip",
      },
    ],
    [
      "no token anywhere",
      { token: "", "snapshot-file": "snap.yml", repository: "o/r" },
      { code: "input-token-missing" },
    ],
  ] as const)("%s is rejected", (_case, inputs, problem) => {
    expect(rejection(snapshot(inputs))).toEqual(problem);
  });

  test("the rejected set is every declared input the snapshot does not read", () => {
    expect(SNAPSHOT_REJECTED_INPUTS).toEqual([
      "settings-file",
      "merged-file",
      "required-sections",
      "defaults-file",
      "layering",
      "private-report",
      "report-public-key",
    ]);
  });

  test.each([
    ["settings-file", { "settings-file": "other.yml" }, ["settings-file"]],
    ["merged-file", { "merged-file": "out.yml" }, ["merged-file"]],
    ["required-sections", { "required-sections": "labels" }, ["required-sections"]],
    ["defaults-file", { "defaults-file": "defaults.yml" }, ["defaults-file"]],
    ["layering", { layering: "replace" }, ["layering"]],
    ["private-report", { "private-report": "issue" }, ["private-report"]],
    ["report-public-key", { "report-public-key": "age1x" }, ["report-public-key"]],
    [
      "several at once, every one named in declaration order",
      { "defaults-file": "d.yml", "settings-file": "s.yml", layering: "merge" },
      ["settings-file", "defaults-file", "layering"],
    ],
  ] as const)(
    "%s is rejected: a snapshot applies nothing, folds nothing, and reports nothing",
    (_case, inputs, named) => {
      expect(
        rejection(snapshot({ "snapshot-file": "snap.yml", repository: "o/r", ...inputs })),
      ).toEqual({ code: "input-rejected-in-snapshot", inputs: named });
    },
  );

  test("every declared default passes: the runner supplies them whether or not the workflow set the input", () => {
    const defaults = Object.fromEntries(
      Object.entries(INPUT_DECLS)
        .filter(([name]) => !["mode", "snapshot-file", "repository", "token"].includes(name))
        .map(([name, decl]) => [name, decl.default]),
    ) as Partial<Record<InputName, string>>;
    expect(snapshot({ "snapshot-file": "snap.yml", repository: "o/r", ...defaults })).toEqual(
      ok({
        ...SHARED,
        form: "file",
        repo: { owner: "o", name: "r", slug: "o/r" },
        snapshotFile: "snap.yml",
      }),
    );
  });
});
