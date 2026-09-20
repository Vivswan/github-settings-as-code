import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import {
  type ConfigEnv,
  DEFAULT_DISCOVERY_FILTERS,
  type Problem,
  parseConfig,
  type RunConfig,
  SECTION_KEYS,
  SectionSelection,
} from "../../src/index.js";
import { INPUT_DECLS, type InputName } from "../../src/internal.js";

/** Parse a step's inputs (unset ones read as empty, as the runner reports them) under `env`, as the action's face does. */
function parse(inputs: Partial<Record<InputName, string>>, env: ConfigEnv = {}) {
  return parseConfig((name) => inputs[name] ?? "", env, { artifactUpload: true });
}

/** A single-repo apply run's inputs, with `inputs` on top. */
function single(inputs: Partial<Record<InputName, string>>, env: ConfigEnv = {}) {
  return parse({ token: "t", repository: "o/r", ...inputs }, env);
}

/** A mode: render run's inputs: no token anywhere, the two layers, the output path, plus `inputs`. */
function merge(inputs: Partial<Record<InputName, string>>) {
  return parse({
    mode: "render",
    "settings-file": "fleet.yml\nrepo.yml",
    "rendered-file": "out/merged.yml",
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
  if (config.kind === "render" || config.kind === "snapshot") {
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
      allowed: ["apply", "check", "render", "snapshot"],
      fallback: "apply",
    });
  });

  test.each([
    ["layering", { layering: "replace" }, ["layering"]],
    [
      "both render-only inputs",
      { layering: "deep", "rendered-file": "out.yml" },
      ["rendered-file", "layering"],
    ],
  ] as const)("%s outside render mode is rejected", (_case, inputs, named) => {
    expect(rejection(single({ mode: "check", ...inputs }))).toEqual({
      code: "input-render-only",
      inputs: named,
      mode: "check",
    });
  });

  test.each([
    ["snapshot-file", { "snapshot-file": "snap.yml" }, ["snapshot-file"]],
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

  test("a render-only input set beside a snapshot-only one is reported first: the first problem wins", () => {
    expect(
      rejection(single({ mode: "check", "rendered-file": "out.yml", "snapshot-dir": "snapshots" })),
    ).toEqual({ code: "input-render-only", inputs: ["rendered-file"], mode: "check" });
  });

  // A stray separator is refused rather than repaired: "only.yml," is one path to a splitter and still not a file.
  test.each<["apply" | "check", string, string]>([
    ["apply", "a comma list", "a.yml,b.yml"],
    ["apply", "a newline list", "a.yml\nb.yml"],
    ["apply", "a trailing separator", "only.yml,"],
    ["apply", "a leading separator", ",only.yml"],
    ["apply", "an empty list", ","],
    ["check", "a comma list", "a.yml,b.yml"],
  ])("%s mode rejects a settings-file with %s rather than repairing it", (mode, _case, value) => {
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

describe("mode: render", () => {
  /** What the two-layer merge inputs parse to; the tests below vary one input around it. */
  const RENDER_CONFIG: Extract<RunConfig, { kind: "render" }> = {
    kind: "render",
    settingsFiles: ["fleet.yml", "repo.yml"],
    renderedFile: "out/merged.yml",
    layering: "deep",
  };

  test("parses without any token, carrying the ordered layers, the output path, and the layering", () => {
    expect(merge({ layering: "replace" })).toEqual(ok({ ...RENDER_CONFIG, layering: "replace" }));
  });

  test("the layering input defaults to deep and a comma list of layers works too", () => {
    expect(merge({ "settings-file": " fleet.yml , team.yml ,repo.yml" })).toEqual(
      ok({ ...RENDER_CONFIG, settingsFiles: ["fleet.yml", "team.yml", "repo.yml"] }),
    );
  });

  test("an empty layer list is rejected", () => {
    expect(rejection(merge({ "settings-file": "," }))).toEqual({
      code: "input-settings-file-empty",
      value: ",",
    });
  });

  test("a missing rendered-file is rejected", () => {
    expect(rejection(merge({ "rendered-file": "" }))).toEqual({
      code: "input-rendered-file-missing",
    });
  });

  test("a rendered-file beside the layers is accepted; the collision with a layer is the fold's to refuse", () => {
    expect(merge({ "rendered-file": "./merged.yml" })).toEqual(
      ok({ ...RENDER_CONFIG, renderedFile: "./merged.yml" }),
    );
  });

  test("an unsupported layering is rejected, the retired `merge` like any other", () => {
    expect(rejection(merge({ layering: "merge" }))).toEqual({
      code: "input-unsupported-value",
      input: "layering",
      value: "merge",
      noun: "layering",
      allowed: ["replace", "shallow", "deep"],
      fallback: "deep",
    });
  });

  // RENDER_REJECTED_INPUTS is every declared input outside RENDER_INPUTS; test/docs/guides.test.ts pins the set against
  // the layering guide. The rows here hold the filter's two clauses (an empty default, a non-empty one) and the order.
  test.each([
    ["repos, whose default is empty", { repos: "o/a" }, ["repos"]],
    [
      "a custom api-version, set off its non-empty default",
      { "api-version": "2099-01-01" },
      ["api-version"],
    ],
    [
      "several at once, every one named in declaration order",
      { repos: "o/a", "repos-dir": "repos", "private-report": "artifact" },
      ["repos", "repos-dir", "private-report"],
    ],
  ] as const)(
    "%s is rejected: a merge has no repository, API, report, or allowlist",
    (_case, inputs, named) => {
      expect(rejection(merge(inputs))).toEqual({ code: "input-rejected-in-render", inputs: named });
    },
  );

  test("every declared default passes: the runner supplies them whether or not the workflow set the input", () => {
    // Every input outside the merge inputs themselves, at the exact value
    // action.yml declares (token's is the unresolved workflow expression; the
    // runner resolves it, which is why token is tolerated at any value).
    const defaults = Object.fromEntries(
      Object.entries(INPUT_DECLS)
        .filter(([name]) => !["mode", "settings-file", "rendered-file"].includes(name))
        .map(([name, decl]) => [name, decl.default]),
    );
    expect(merge(defaults)).toEqual(ok(RENDER_CONFIG));
  });

  test("token is tolerated and never carried: the config has no field to read it from", () => {
    const parsed = parse(
      {
        mode: "render",
        "settings-file": "fleet.yml\nrepo.yml",
        "rendered-file": "out/merged.yml",
        token: "ghp_stepwide",
      },
      { GITHUB_TOKEN: "ghp_envwide" },
    );
    expect(parsed).toEqual(ok(RENDER_CONFIG));
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

  // SNAPSHOT_REJECTED_INPUTS is every declared input outside SNAPSHOT_INPUTS; test/docs/guides.test.ts pins the set
  // against the snapshot guide. The rows here hold the filter, as the merge rows above do.
  test.each([
    [
      "settings-file, set off its non-empty default",
      { "settings-file": "other.yml" },
      ["settings-file"],
    ],
    [
      "defaults-file, whose default is empty",
      { "defaults-file": "defaults.yml" },
      ["defaults-file"],
    ],
    [
      "several at once, every one named in declaration order",
      { "defaults-file": "d.yml", "settings-file": "s.yml", layering: "deep" },
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
