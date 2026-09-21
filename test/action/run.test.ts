import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { run } from "../../src/action/run.js";
import type { Layering } from "../../src/engine/layers.js";
import { type Io, maskRegistry } from "../../src/io.js";
import { describeProblem, type Problem } from "../../src/problem.js";
import type { ArtifactUploader } from "../../src/report/artifact-report.js";
import { REPORT_HEADING } from "../../src/report/composer.js";
import { ISSUE_TITLE, MARKER_LABEL } from "../../src/report/issue-report.js";
import { MockApi } from "../mock-api.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

// A capturing Io replaces the @actions/core sink, so a green suite prints no raw workflow commands and the failure-path tests assert the exact
// captured text.
let captured: string[] = [];
let summaries: string[] = [];
let outputs: Record<string, string> = {};
const testIo: Io = {
  annotate: (level, message) => captured.push(`${level}: ${message}`),
  log: (line) => captured.push(line),
  debug: () => {},
  summary: (markdown) => summaries.push(markdown),
  output: (name, value) => {
    outputs[name] = value;
  },
  ...maskRegistry((value) => captured.push(`mask: ${value}`)),
};
beforeEach(() => {
  captured = [];
  summaries = [];
  outputs = {};
});

// A well-formed age recipient for the rows where the key's shape is not the rule under test.
const VALID_KEY = await identityToRecipient(await generateX25519Identity());

describe("run in multi-repo mode (env glue)", () => {
  const ENV_KEYS = [
    "INPUT_TOKEN",
    "INPUT_MODE",
    "INPUT_REPOS",
    "INPUT_REPOSITORY",
    "INPUT_VISIBILITY",
    "INPUT_ARCHIVED",
    "INPUT_FORKS",
    "INPUT_EXCLUDE",
    "INPUT_TOPICS",
    "INPUT_AFFILIATION",
    "GITHUB_REPOSITORY",
    "INPUT_PRIVATE-REPOS",
    "INPUT_PRIVATE-REPORT",
    "INPUT_REPORT-PUBLIC-KEY",
    "INPUT_SETTINGS-FILE",
    "INPUT_DEFAULTS-FILE",
  ];
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // A discovery run starts from a token and a mode alone: every other input of this describe is unset until the test sets it.
  function setDiscoveryEnv() {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_MODE = "check";
  }

  test("discovery with forks: exclude processes only the non-fork", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "*";
    process.env.INPUT_FORKS = "exclude";
    const api = new MockApi({
      "GET /user/repos?affiliation=owner&per_page=100&page=1": {
        data: [
          { full_name: "o/x", private: false },
          { full_name: "o/y", fork: true, private: false },
        ],
      },
      "GET /repos/o/x": { data: { has_wiki: false, private: false } },
      "GET /repos/o/x/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    expect(await run({ api: api, io: testIo })).toBe(0);
    expect(api.calls.some((c) => c.path.startsWith("/repos/o/y"))).toBe(false);
  });

  test("the step summary escapes pipes and marks drift rows", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "o/a";
    const api = new MockApi({
      "GET /repos/o/a": { data: { description: "live | desc", private: false } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: 'repository:\n  description: "want | desc"\n',
      },
    });
    expect(await run({ api: api, io: testIo })).toBe(1);
    const summary = summaries.join("\n");
    expect(summary).toContain(":warning: drift");
    expect(summary).toContain("want \\| desc");
  });

  test("self-target single-repo run is never redacted (carve-out)", async () => {
    setDiscoveryEnv();
    delete process.env.INPUT_REPOS;
    process.env.INPUT_REPOSITORY = "o/self";
    process.env.GITHUB_REPOSITORY = "o/self";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env.INPUT_MODE = "check";
    const api = new MockApi({ "GET /repos/o/self": { data: { has_wiki: false, private: true } } });
    expect(await run({ api: api, io: testIo })).toBe(0);
    const summary = summaries.join("\n");
    expect(summary).not.toContain("details hidden");
    expect(summary).toContain("repository");
    // The self carve-out skips the visibility probe: the one GET is the engine's.
    const gets = api.calls.filter((c) => c.method === "GET" && c.path === "/repos/o/self");
    expect(gets).toHaveLength(1);
  });

  // The error annotation must name ITS OWN rule: exit code and call count alone would pass on a wrong-rule rejection.
  const SINGLE = { INPUT_REPOSITORY: "o/r", "INPUT_SETTINGS-FILE": "test/fixtures/single.yml" };
  const REDACT = { ...SINGLE, "INPUT_PRIVATE-REPOS": "redact" };
  const SHOW = { ...SINGLE, "INPUT_PRIVATE-REPOS": "show" };
  const NEVER_SENT = "nothing is redacted and no report would ever be sent";
  const ARTIFACT_ONLY = "only applies to private-report: artifact";
  const MALFORMED_KEY = "age1notavalidkey"; // gitleaks:allow
  const FILTER = (input: string, value: string) =>
    `the "${input}" input is "${value}", which is not a supported`;
  const EXCLUDE = (pattern: string): Problem => ({
    code: "input-exclude-pattern-invalid",
    pattern,
  });
  // A row names the whole Problem where that is the rule, and a message fragment where the whole message would restate
  // the input's option list or a library's own wording.
  test.each<[string, Record<string, string>, Problem | string]>([
    [
      "repository with repos",
      { INPUT_REPOS: "o/a", INPUT_REPOSITORY: "o/r" },
      { code: "input-repository-with-multi" },
    ],
    [
      "visibility: sometimes",
      { INPUT_REPOS: "*", INPUT_VISIBILITY: "sometimes" },
      FILTER("visibility", "sometimes"),
    ],
    ["archived: maybe", { INPUT_REPOS: "*", INPUT_ARCHIVED: "maybe" }, FILTER("archived", "maybe")],
    ["forks: never", { INPUT_REPOS: "*", INPUT_FORKS: "never" }, FILTER("forks", "never")],
    [
      "affiliation: member",
      { INPUT_REPOS: "*", INPUT_AFFILIATION: "member" },
      'the "affiliation" input entry "member" is not a supported affiliation',
    ],
    ["exclude: a/b/c", { INPUT_REPOS: "*", INPUT_EXCLUDE: "a/b/c" }, EXCLUDE("a/b/c")],
    ["exclude: octo/", { INPUT_REPOS: "*", INPUT_EXCLUDE: "octo/" }, EXCLUDE("octo/")],
    ["exclude: /repo", { INPUT_REPOS: "*", INPUT_EXCLUDE: "/repo" }, EXCLUDE("/repo")],
    [
      "a filter with an explicit repos list",
      { INPUT_REPOS: "o/a", INPUT_FORKS: "exclude" },
      { code: "discovery-filters-without-wildcard", filters: ["forks"], targets: "explicit-repos" },
    ],
    [
      "a filter in single-repo mode",
      { INPUT_REPOSITORY: "o/r", INPUT_TOPICS: "team-a" },
      { code: "discovery-filters-without-wildcard", filters: ["topics"], targets: "single-repo" },
    ],
    [
      "defaults-file in single-repo mode",
      { INPUT_REPOSITORY: "o/r", "INPUT_DEFAULTS-FILE": "test/fixtures/defaults.yml" },
      { code: "input-defaults-file-without-multi" },
    ],
    [
      "private-report: issue with private-repos: show",
      { ...SHOW, "INPUT_PRIVATE-REPORT": "issue" },
      NEVER_SENT,
    ],
    [
      "private-report: issue-on-failure with private-repos: show",
      { ...SHOW, "INPUT_PRIVATE-REPORT": "issue-on-failure" },
      NEVER_SENT,
    ],
    [
      "private-report: artifact with private-repos: show",
      { ...SHOW, "INPUT_PRIVATE-REPORT": "artifact", "INPUT_REPORT-PUBLIC-KEY": VALID_KEY },
      NEVER_SENT,
    ],
    [
      "private-report: artifact without report-public-key",
      { ...REDACT, "INPUT_PRIVATE-REPORT": "artifact" },
      'private-report: artifact needs a "report-public-key" input',
    ],
    [
      "private-report: artifact with a malformed report-public-key",
      { ...REDACT, "INPUT_PRIVATE-REPORT": "artifact", "INPUT_REPORT-PUBLIC-KEY": MALFORMED_KEY },
      "not a valid age recipient",
    ],
    [
      "report-public-key with the issue channel",
      { ...REDACT, "INPUT_PRIVATE-REPORT": "issue", "INPUT_REPORT-PUBLIC-KEY": VALID_KEY },
      ARTIFACT_ONLY,
    ],
    [
      "report-public-key with the issue-on-failure channel",
      {
        ...REDACT,
        "INPUT_PRIVATE-REPORT": "issue-on-failure",
        "INPUT_REPORT-PUBLIC-KEY": VALID_KEY,
      },
      ARTIFACT_ONLY,
    ],
    [
      "report-public-key with the default none channel",
      { ...REDACT, "INPUT_PRIVATE-REPORT": "none", "INPUT_REPORT-PUBLIC-KEY": VALID_KEY },
      ARTIFACT_ONLY,
    ],
  ])("%s is a hard config error naming its rule", async (_name, env, expected) => {
    setDiscoveryEnv();
    Object.assign(process.env, env);
    const api = new MockApi({});
    expect(await run({ api: api, io: testIo })).toBe(1);
    expect(api.calls).toHaveLength(0);
    const errors = captured.filter((line) => line.startsWith("error: "));
    if (typeof expected === "string") {
      expect(errors.join("\n")).toContain(expected);
    } else {
      expect(errors).toContain(`error: ${describeProblem(expected)}`);
    }
  });

  // Check mode; a drifting row has has_wiki: true against single.yml's false.
  const listPath = (state: string) =>
    `GET /repos/o/priv/issues?state=${state}&labels=${MARKER_LABEL}&per_page=100&page=1`;
  const issue3 = {
    number: 3,
    title: ISSUE_TITLE,
    body: `${REPORT_HEADING} o/priv`,
    html_url: "https://github.com/o/priv/issues/3",
  };
  test.each<
    [
      string,
      string,
      boolean,
      Record<string, { data?: unknown; error?: { status: number; message: string; body: string } }>,
      number,
      string[],
    ]
  >([
    [
      "issue",
      "issue",
      true,
      {
        "POST /repos/o/priv/labels": { error: { status: 422, message: "exists", body: "" } },
        [listPath("all")]: { data: [issue3] },
        "PATCH /repos/o/priv/issues/3": { data: { number: 3 } },
      },
      1,
      ["POST /repos/o/priv/labels", "PATCH /repos/o/priv/issues/3"],
    ],
    [
      "issue-on-failure on a drifting target",
      "issue-on-failure",
      true,
      {
        "POST /repos/o/priv/labels": { error: { status: 422, message: "exists", body: "" } },
        [listPath("all")]: { data: [issue3] },
        "PATCH /repos/o/priv/issues/3": { data: { number: 3 } },
      },
      1,
      ["POST /repos/o/priv/labels", "PATCH /repos/o/priv/issues/3"],
    ],
    [
      "issue-on-failure on a healthy target",
      "issue-on-failure",
      false,
      { [listPath("open")]: { data: [] } },
      0,
      [],
    ],
    ["artifact", "artifact", true, {}, 1, []],
  ])(
    "single-repo proven-private target under %s: report delivered through that channel, result untouched, public summary redacted",
    async (_name, channel, drifts, routes, exitCode, writes) => {
      const identity = await generateX25519Identity();
      const uploads: Uint8Array[] = [];
      const uploader: ArtifactUploader = {
        async upload(_name, file) {
          uploads.push(file.data);
          return { uploaded: true as const };
        },
      };
      setDiscoveryEnv();
      delete process.env.INPUT_REPOS;
      process.env.INPUT_REPOSITORY = "o/priv";
      process.env.GITHUB_REPOSITORY = "admin/repo";
      process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
      process.env["INPUT_PRIVATE-REPOS"] = "redact";
      process.env["INPUT_PRIVATE-REPORT"] = channel;
      if (channel === "artifact") {
        process.env["INPUT_REPORT-PUBLIC-KEY"] = await identityToRecipient(identity);
      } else {
        delete process.env["INPUT_REPORT-PUBLIC-KEY"];
      }
      process.env.INPUT_MODE = "check";
      const api = new MockApi({
        "GET /repos/o/priv": { data: { has_wiki: drifts, private: true } },
        ...routes,
      });
      expect(await run({ api, io: testIo, uploader })).toBe(exitCode);
      expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual(writes);
      expect(outputs.result).toBe(drifts ? "drift" : "clean");
      // The report body, wherever it went, is the unredacted mirror of the run.
      let body: string;
      if (channel === "artifact") {
        expect(uploads).toHaveLength(1);
        const decrypter = new Decrypter();
        decrypter.addIdentity(identity);
        body = await decrypter.decrypt(uploads[0] as Uint8Array, "text");
        expect(body).toStartWith("<!-- private repository #1 -->");
      } else {
        expect(uploads).toEqual([]);
        const patch = api.calls.find((c) => c.method === "PATCH");
        const payload = (patch?.payload ?? {}) as { body?: string; state?: string };
        expect(payload.state).toBe(writes.length > 0 ? "open" : undefined);
        body = payload.body ?? "";
      }
      if (writes.length > 0 || channel === "artifact") {
        expect(body).toContain("# settings-as-code private report: o/priv");
        expect(body).toContain("## Transcript");
      }
      // The public surfaces stay redacted throughout; only the mask registration names the slug. The summary keeps
      // the per-section statuses and hides the live values behind the placeholder note.
      expect(captured).toContain("mask: o/priv");
      const publicText = [...captured.filter((line) => !line.startsWith("mask: ")), ...summaries];
      expect(publicText.join("\n")).not.toContain("o/priv");
      expect(publicText.join("\n")).not.toContain("has_wiki");
      const summary = summaries.join("\n");
      expect(summary).toContain("details hidden");
      expect(summary).toContain("| Section | Status | Detail |");
      expect(summary).toContain(drifts ? ":warning: drift" : ":white_check_mark: clean");
      expect(summary).toContain("hidden (private repository)");
    },
  );

  test("single-repo unknown visibility redacts but does NOT deliver the report", async () => {
    setDiscoveryEnv();
    delete process.env.INPUT_REPOS;
    process.env.INPUT_REPOSITORY = "o/maybe";
    process.env.GITHUB_REPOSITORY = "admin/repo";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env["INPUT_PRIVATE-REPORT"] = "issue";
    process.env.INPUT_MODE = "check";
    const api = new MockApi({ "GET /repos/o/maybe": { data: { has_wiki: true } } });
    expect(await run({ api: api, io: testIo })).toBe(1); // drift exits 1
    expect(api.calls.some((c) => c.path.includes("/issues"))).toBe(false);
    expect(api.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels"))).toBe(false);
    const withheld = captured.find((line) => line.includes("visibility could not be verified"));
    expect(withheld).toStartWith("notice: private repository #1: ");
    expect(captured.join("\n").replace("mask: o/maybe", "")).not.toContain("o/maybe");
  });
});

describe("run in mode: render", () => {
  const ENV_KEYS = [
    "INPUT_TOKEN",
    "GITHUB_TOKEN",
    "INPUT_MODE",
    "INPUT_REPOSITORY",
    "INPUT_SETTINGS-FILE",
    "INPUT_RENDERED-FILE",
    "INPUT_LAYERING",
    "INPUT_SECTIONS",
    "GITHUB_REPOSITORY",
  ];
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const FIXTURES = join(ROOT, "test", "fixtures", "layers");
  const layer = (name: string) => join(FIXTURES, name);
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  /** A merge run's env: NO token anywhere, the layers low to high, the output path under `dir`, which is returned. */
  function setRenderEnv(
    dir: string,
    layers: string[],
    inputs: { layering?: Layering } = {},
  ): string {
    const renderedFile = join(dir, "out", "merged.yml");
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env.INPUT_MODE = "render";
    process.env["INPUT_SETTINGS-FILE"] = layers.join("\n");
    process.env["INPUT_RENDERED-FILE"] = renderedFile;
    if (inputs.layering) {
      process.env.INPUT_LAYERING = inputs.layering;
    }
    return renderedFile;
  }

  /** Write a layer document into the temp dir and return its path. */
  function tempLayer(dir: string, name: string, doc: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, stringifyYaml(doc));
    return path;
  }

  const FLEET_RULESET = {
    name: "main",
    target: "branch",
    enforcement: "active",
    rules: [{ type: "deletion" }],
  };

  /** fleet < team < repo under the default deep layering: what the three fixtures fold to. */
  const THREE_LAYERS_MERGED = {
    repository: { has_wiki: false, has_projects: false, has_issues: true, description: "mine" },
    labels: {
      _undeclared: "delete",
      entries: [
        { name: "docs", color: "ffffff" },
        { name: "team", color: "00ff00" },
      ],
    },
    rulesets: {
      _undeclared: "keep",
      entries: [{ ...FLEET_RULESET, rules: [{ type: "deletion" }, { type: "non_fast_forward" }] }],
    },
    pages: null,
  };

  test("three layers fold into the merged file with no token and no API call; a removal drops an entry with a notice, and pages: null is the value", () =>
    withTempDir("render-mode-", async (dir) => {
      const layers = [layer("fleet.yml"), layer("team.yml"), layer("repo.yml")];
      const renderedFile = setRenderEnv(dir, layers);
      const api = new MockApi({});
      expect(await run({ api, io: testIo })).toBe(0);
      expect(api.calls).toEqual([]);
      expect(parseYaml(readFileSync(renderedFile, "utf8"))).toEqual(THREE_LAYERS_MERGED);
      expect(outputs).toEqual({ result: "rendered", "skipped-sections": "", "repos-result": "{}" });
      expect(captured).toEqual([
        `notice: ${layer("team.yml")}: labels[0] carries _remove: true and dropped the entry a lower layer declared under its key`,
        `rendered 3 layers into ${renderedFile}`,
        "result: rendered",
      ]);
      expect(summaries).toEqual([
        [
          "## github-settings-as-code (render)",
          "",
          "| Layer | Settings file |",
          "|---|---|",
          `| 1 | ${layer("fleet.yml")} |`,
          `| 2 | ${layer("team.yml")} |`,
          `| 3 | ${layer("repo.yml")} |`,
          "",
          `Rendered document written to ${renderedFile}.`,
        ].join("\n"),
      ]);
    }));

  test("layering: replace lets the higher layer's list sections win while mappings still merge", () =>
    withTempDir("render-mode-", async (dir) => {
      const renderedFile = setRenderEnv(dir, [layer("fleet.yml"), layer("repo.yml")], {
        layering: "replace",
      });
      expect(await run({ api: new MockApi({}), io: testIo })).toBe(0);
      expect(parseYaml(readFileSync(renderedFile, "utf8"))).toEqual({
        repository: { has_wiki: false, has_projects: false, description: "mine" },
        labels: { _undeclared: "delete", entries: [{ name: "docs", color: "ffffff" }] },
        rulesets: { _undeclared: "keep", entries: [FLEET_RULESET] },
        pages: null,
      });
    }));

  test.each([
    ["a mapping", { setting: true }],
    // A null on an unknown key is no opt-out marker: nothing known is being removed, so it is the same misspelling.
    ["null", null],
  ])(
    "a layer with an unknown top-level key set to %s fails naming the layer: a merge has no allowlist to tolerate it",
    (_case, value) =>
      withTempDir("render-mode-", async (dir) => {
        const top = tempLayer(dir, "top.yml", {
          future: value,
          rulesets: [{ name: "tags", target: "tag" }],
        });
        const renderedFile = setRenderEnv(dir, [layer("fleet.yml"), top]);
        expect(await run({ api: new MockApi({}), io: testIo })).toBe(1);
        expect(existsSync(renderedFile)).toBe(false);
        expect(captured).toEqual([
          expect.stringMatching(
            new RegExp(
              `^error: ${top.replaceAll(".", "\\.")} has malformed section entries: unknown top-level section: future \\(known: `,
            ),
          ),
          "result: failed",
        ]);
      }),
  );
});

describe("run in mode: snapshot", () => {
  const ENV_KEYS = [
    "INPUT_TOKEN",
    "INPUT_MODE",
    "INPUT_REPOSITORY",
    "INPUT_SETTINGS-FILE",
    "INPUT_SNAPSHOT-FILE",
    "INPUT_SECTIONS",
    "GITHUB_REPOSITORY",
  ];
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  /** A snapshot run's env: the token, the target, the file under `dir` (returned), the labels allowlist. */
  function setSnapshotEnv(dir: string): string {
    const snapshotFile = join(dir, "out", "snapshot.yml");
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_MODE = "snapshot";
    // The workflow's own repository: the self carve-out skips the visibility
    // probe, so the target is shown without a repository route.
    process.env.GITHUB_REPOSITORY = "o/r";
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_SNAPSHOT-FILE"] = snapshotFile;
    process.env.INPUT_SECTIONS = "labels";
    return snapshotFile;
  }

  const LABELS = [{ name: "bug", color: "d73a4a", description: "Something is broken" }];
  const labelsApi = () =>
    new MockApi({ "GET /repos/o/r/labels?per_page=100&page=1": { data: LABELS } });

  test("snapshot then check: the written file checks clean against the live state it was read from", () =>
    withTempDir("snapshot-mode-", async (dir) => {
      const snapshotFile = setSnapshotEnv(dir);
      expect(await run({ api: labelsApi(), io: testIo })).toBe(0);
      for (const key of ENV_KEYS) {
        delete process.env[key];
      }
      process.env.INPUT_TOKEN = "t";
      process.env.INPUT_MODE = "check";
      process.env.GITHUB_REPOSITORY = "o/r";
      process.env.INPUT_REPOSITORY = "o/r";
      process.env.INPUT_SECTIONS = "labels";
      process.env["INPUT_SETTINGS-FILE"] = snapshotFile;
      const api = labelsApi();
      expect(await run({ api, io: testIo })).toBe(0);
      expect(api.mutations()).toEqual([]);
      expect(outputs.result).toBe("clean");
    }));
});
