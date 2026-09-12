import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { run } from "../../src/action/run.js";
import { type Io, maskRegistry } from "../../src/io.js";
import type { ArtifactUploader } from "../../src/report/artifact-report.js";
import { REPORT_HEADING } from "../../src/report/composer.js";
import { SECTION_KEYS } from "../../src/schema.js";
import { MockApi } from "../mock-api.js";

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

describe("run (legacy single-repo regression)", () => {
  const ENV_KEYS = ["INPUT_TOKEN", "INPUT_MODE", "INPUT_REPOSITORY", "INPUT_SETTINGS-FILE"];
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

  function setEnv() {
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
  }

  test("check mode: clean exits 0, drift exits 1", async () => {
    setEnv();
    process.env.INPUT_MODE = "check";
    const clean = new MockApi({ "GET /repos/o/r": { data: { has_wiki: false } } });
    expect(await run({ api: clean, io: testIo })).toBe(0);
    const drifted = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } });
    expect(await run({ api: drifted, io: testIo })).toBe(1);
  });

  test("apply mode patches the declared keys and exits 0", async () => {
    setEnv();
    process.env.INPUT_MODE = "apply";
    const api = new MockApi({ "GET /repos/o/r": { data: { has_wiki: true } } }).allowMutations(
      "PATCH /repos/o/r",
    );
    expect(await run({ api: api, io: testIo })).toBe(0);
    expect(api.mutations()).toEqual([
      { method: "PATCH", path: "/repos/o/r", payload: { has_wiki: false } },
    ]);
  });
});

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

  test("writes repos-result and result outputs and exits by worst-of", async () => {
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_MODE = "check";
    process.env.INPUT_REPOS = "o/a";
    delete process.env.INPUT_REPOSITORY;
    const api = new MockApi({
      "GET /repos/o/a": { data: { has_wiki: false, private: false } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    expect(await run({ api: api, io: testIo })).toBe(0);
    const output = outputs["repos-result"] ?? "";
    expect(outputs.result).toBe("clean");
    expect(output).toContain('"o/a":{"result":"clean","source":"remote"');
  });

  test("repository input combined with repos is a hard error", async () => {
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_MODE = "check";
    process.env.INPUT_REPOS = "o/a";
    process.env.INPUT_REPOSITORY = "o/r";
    const api = new MockApi({});
    expect(await run({ api: api, io: testIo })).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(captured).toContain(
      'error: the "repository" input cannot be combined with "repos" or "repos-dir"; multi-repo targets come from those inputs. Remove "repository", or remove the multi-repo inputs to stay in single-repo mode',
    );
  });

  function setDiscoveryEnv() {
    process.env.INPUT_TOKEN = "t";
    process.env.INPUT_MODE = "check";
    delete process.env.INPUT_REPOS;
    delete process.env.INPUT_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
  }

  test("invalid filter values are hard errors before any API call", async () => {
    const bad: Array<[string, string]> = [
      ["INPUT_VISIBILITY", "sometimes"],
      ["INPUT_ARCHIVED", "maybe"],
      ["INPUT_FORKS", "never"],
      ["INPUT_AFFILIATION", "member"],
      ["INPUT_EXCLUDE", "a/b/c"],
      ["INPUT_EXCLUDE", "octo/"],
      ["INPUT_EXCLUDE", "/repo"],
    ];
    for (const [key, value] of bad) {
      setDiscoveryEnv();
      process.env.INPUT_REPOS = "*";
      process.env[key] = value;
      const api = new MockApi({});
      expect(await run({ api: api, io: testIo })).toBe(1);
      expect(api.calls).toHaveLength(0);
      delete process.env[key];
    }
  });

  test("filters with an explicit repos list are a hard error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "o/a";
    process.env.INPUT_FORKS = "exclude";
    const api = new MockApi({});
    expect(await run({ api: api, io: testIo })).toBe(1);
    expect(api.calls).toHaveLength(0);
  });

  test("filters in single-repo mode are a hard error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env.INPUT_TOPICS = "team-a";
    const api = new MockApi({});
    expect(await run({ api: api, io: testIo })).toBe(1);
    expect(api.calls).toHaveLength(0);
  });

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

  test("multi-repo check mode exits 1 on drift and on failure", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "o/a";
    const drifted = new MockApi({
      "GET /repos/o/a": { data: { has_wiki: true, private: false } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    expect(await run({ api: drifted, io: testIo })).toBe(1);
    captured = []; // attribute the assertions below to the failing run alone
    const failing = new MockApi({
      "GET /repos/o/a": { error: { status: 500, message: "boom", body: "" } },
      "GET /repos/o/a/contents/.github/settings.yml": {
        data: "repository:\n  has_wiki: false\n",
      },
    });
    expect(await run({ api: failing, io: testIo })).toBe(1);
    // The error annotation is redacted by default, since the 500 leaves the target's visibility unproven.
    expect(captured).toContain(
      "error: private repository #1: failed - repository. details hidden: the repository is private or internal. Set private-repos: show to reveal them, or run the action inside that repository",
    );
    expect(captured).toContain("result: failed");
  });

  test("defaults-file in single-repo mode is a hard error", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOSITORY = "o/r";
    process.env["INPUT_DEFAULTS-FILE"] = "test/fixtures/defaults.yml";
    const api = new MockApi({});
    expect(await run({ api: api, io: testIo })).toBe(1);
    expect(api.calls).toHaveLength(0);
    delete process.env["INPUT_DEFAULTS-FILE"];
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

  test("redact default: repos-result and summary key a private target by its placeholder", async () => {
    setDiscoveryEnv();
    process.env.INPUT_REPOS = "o/priv";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env.INPUT_MODE = "check";
    const api = new MockApi({
      "GET /repos/o/priv": { data: { description: "SECRET-live", private: true } },
      "GET /repos/o/priv/contents/.github/settings.yml": {
        data: 'repository:\n  description: "SECRET-want"\n',
      },
    });
    expect(await run({ api: api, io: testIo })).toBe(1);
    const output = outputs["repos-result"] ?? "";
    const summary = summaries.join("\n");
    for (const text of [output, summary]) {
      expect(text).not.toContain("o/priv");
      expect(text).not.toContain("SECRET-live");
      expect(text).not.toContain("SECRET-want");
    }
    expect(output).toContain('"private repository #1":{"result":"drift"');
    expect(summary).toContain("private repository #1");
    expect(summary).toContain("hidden (private repository)");
  });

  test("redact single-repo cross-repo target: generic summary, no slug or live values", async () => {
    setDiscoveryEnv();
    delete process.env.INPUT_REPOS;
    process.env.INPUT_REPOSITORY = "o/priv";
    process.env.GITHUB_REPOSITORY = "admin/repo";
    process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
    process.env["INPUT_PRIVATE-REPOS"] = "redact";
    process.env.INPUT_MODE = "check";
    // has_wiki drifts; the live value is a boolean but the slug must not leak.
    const api = new MockApi({
      "GET /repos/o/priv": { data: { has_wiki: true, private: true } },
    });
    expect(await run({ api: api, io: testIo })).toBe(1);
    expect(captured).toContain("mask: o/priv");
    const summary = summaries.join("\n");
    expect(summary).not.toContain("o/priv");
    expect(summary).toContain("details hidden");
    // The redacted single-repo summary renders the SAME per-section table the multi path does: statuses stay visible everywhere, only the detail cell
    // is hidden.
    expect(summary).toContain("| Section | Status | Detail |");
    expect(summary).toContain("repository");
    expect(summary).toContain(":warning: drift");
    expect(summary).toContain("hidden (private repository)");
    expect(summary).not.toContain("has_wiki");
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
  test.each([
    [
      "private-report: issue with private-repos: show",
      "show",
      "issue",
      "absent",
      "nothing is redacted and no report would ever be sent",
    ],
    [
      "private-report: issue-on-failure with private-repos: show",
      "show",
      "issue-on-failure",
      "absent",
      "nothing is redacted and no report would ever be sent",
    ],
    [
      "private-report: artifact with private-repos: show",
      "show",
      "artifact",
      "valid",
      "nothing is redacted and no report would ever be sent",
    ],
    [
      "private-report: artifact without report-public-key",
      "redact",
      "artifact",
      "absent",
      'private-report: artifact needs a "report-public-key" input',
    ],
    [
      "private-report: artifact with a malformed report-public-key",
      "redact",
      "artifact",
      "malformed",
      "not a valid age recipient",
    ],
    [
      "report-public-key with the issue channel",
      "redact",
      "issue",
      "valid",
      "only applies to private-report: artifact",
    ],
    [
      "report-public-key with the issue-on-failure channel",
      "redact",
      "issue-on-failure",
      "valid",
      "only applies to private-report: artifact",
    ],
    [
      "report-public-key with the default none channel",
      "redact",
      "none",
      "valid",
      "only applies to private-report: artifact",
    ],
  ] as const)(
    "%s is a hard config error naming its rule",
    async (_name, privateRepos, privateReport, key, fragment) => {
      setDiscoveryEnv();
      process.env.INPUT_REPOSITORY = "o/r";
      process.env["INPUT_SETTINGS-FILE"] = "test/fixtures/single.yml";
      process.env["INPUT_PRIVATE-REPOS"] = privateRepos;
      process.env["INPUT_PRIVATE-REPORT"] = privateReport;
      if (key === "absent") {
        delete process.env["INPUT_REPORT-PUBLIC-KEY"];
      } else if (key === "malformed") {
        process.env["INPUT_REPORT-PUBLIC-KEY"] = "age1notavalidkey"; // gitleaks:allow
      } else {
        process.env["INPUT_REPORT-PUBLIC-KEY"] = await identityToRecipient(
          await generateX25519Identity(),
        );
      }
      const api = new MockApi({});
      expect(await run({ api: api, io: testIo })).toBe(1);
      expect(api.calls).toHaveLength(0);
      expect(captured.filter((line) => line.startsWith("error: ")).join("\n")).toContain(fragment);
    },
  );

  // Check mode; a drifting row has has_wiki: true against single.yml's false.
  const ISSUE_TITLE = "[automated] settings-as-code: private settings report";
  const listPath = (state: string) =>
    `GET /repos/o/priv/issues?state=${state}&labels=settings-as-code-report&per_page=100&page=1`;
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
        expect(body).toStartWith("<!-- private repository -->");
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
      // The public surfaces stay redacted throughout; only the mask registration names the slug.
      expect(captured).toContain("mask: o/priv");
      const publicText = [...captured.filter((line) => !line.startsWith("mask: ")), ...summaries];
      expect(publicText.join("\n")).not.toContain("o/priv");
      expect(summaries.join("\n")).toContain("details hidden");
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
    expect(withheld).toStartWith("notice: private repository: ");
    expect(captured.join("\n").replace("mask: o/maybe", "")).not.toContain("o/maybe");
  });
});

describe("run in mode: merge", () => {
  const ENV_KEYS = [
    "INPUT_TOKEN",
    "GITHUB_TOKEN",
    "INPUT_MODE",
    "INPUT_REPOSITORY",
    "INPUT_SETTINGS-FILE",
    "INPUT_MERGED-FILE",
    "INPUT_LAYERING",
    "INPUT_SECTIONS",
    "GITHUB_REPOSITORY",
  ];
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const FIXTURES = join(import.meta.dir, "..", "fixtures", "layers");
  const layer = (name: string) => join(FIXTURES, name);
  let dir: string;
  let mergedFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "merge-mode-"));
    mergedFile = join(dir, "out", "merged.yml");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  /** A merge run's env: NO token anywhere, the layers low to high, the output path. */
  function setMergeEnv(layers: string[], inputs: { layering?: "merge" | "replace" } = {}) {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env.INPUT_MODE = "merge";
    process.env["INPUT_SETTINGS-FILE"] = layers.join("\n");
    process.env["INPUT_MERGED-FILE"] = mergedFile;
    if (inputs.layering) {
      process.env.INPUT_LAYERING = inputs.layering;
    }
  }

  /** Write a layer document into the temp dir and return its path. */
  function tempLayer(name: string, doc: unknown): string {
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

  /** fleet < team < repo under the merge layering: what the three fixtures fold to. */
  const THREE_LAYERS_MERGED = {
    repository: { has_wiki: false, description: "mine" },
    labels: {
      _undeclared: "delete",
      entries: [
        { name: "bug", color: "d73a4a" },
        { name: "docs", color: "ffffff" },
        { name: "team", color: "00ff00" },
      ],
    },
    rulesets: {
      _undeclared: "keep",
      entries: [{ ...FLEET_RULESET, rules: [{ type: "deletion" }, { type: "non_fast_forward" }] }],
    },
  };

  test("three layers fold into the merged file with no token and no API call; nulls opt out with notices", async () => {
    const layers = [layer("fleet.yml"), layer("team.yml"), layer("repo.yml")];
    setMergeEnv(layers);
    const api = new MockApi({});
    expect(await run({ api, io: testIo })).toBe(0);
    expect(api.calls).toEqual([]);
    expect(parseYaml(readFileSync(mergedFile, "utf8"))).toEqual(THREE_LAYERS_MERGED);
    expect(outputs).toEqual({ "skipped-sections": "", result: "merged" });
    expect(captured).toEqual([
      `notice: ${layer("team.yml")}: null removed repository.has_projects declared by a lower layer`,
      `notice: ${layer("repo.yml")}: null removed pages declared by a lower layer`,
      `merged 3 layer(s) into ${mergedFile}`,
      "result: merged",
    ]);
    expect(summaries).toEqual([
      [
        "## github-settings-as-code (merge)",
        "",
        "| Layer | Settings file |",
        "|---|---|",
        `| 1 | ${layer("fleet.yml")} |`,
        `| 2 | ${layer("team.yml")} |`,
        `| 3 | ${layer("repo.yml")} |`,
        "",
        `Merged document written to ${mergedFile}.`,
      ].join("\n"),
    ]);
  });

  test("a layer that is invalid on its own fails the run naming the layer, before any merge or write", async () => {
    const broken = tempLayer("broken.yml", { labels: [{ color: "ffffff" }] });
    setMergeEnv([layer("fleet.yml"), broken]);
    const api = new MockApi({});
    expect(await run({ api, io: testIo })).toBe(1);
    expect(api.calls).toEqual([]);
    expect(existsSync(mergedFile)).toBe(false);
    expect(outputs).toEqual({ "skipped-sections": "", result: "failed" });
    const errors = captured.filter((line) => line.startsWith("error: "));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith(
      `error: ${broken} has malformed section entries: labels[0].name:`,
    );
  });

  test("an unreadable layer fails the run naming the path and the input", async () => {
    const missing = join(dir, "nope.yml");
    setMergeEnv([layer("fleet.yml"), missing]);
    expect(await run({ api: new MockApi({}), io: testIo })).toBe(1);
    expect(captured.filter((line) => line.startsWith("error: "))).toEqual([
      `error: cannot read the settings layer ${missing}: Error: ENOENT: no such file or directory, open '${missing}'. Check that every path in the "settings-file" input exists and is valid YAML`,
    ]);
  });

  test("layering: replace lets the higher layer's keyed lists win while mappings still merge", async () => {
    setMergeEnv([layer("fleet.yml"), layer("repo.yml")], { layering: "replace" });
    expect(await run({ api: new MockApi({}), io: testIo })).toBe(0);
    expect(parseYaml(readFileSync(mergedFile, "utf8"))).toEqual({
      repository: { has_wiki: false, has_projects: false, description: "mine" },
      labels: { _undeclared: "delete", entries: [{ name: "docs", color: "ffffff" }] },
      rulesets: { _undeclared: "keep", entries: [FLEET_RULESET] },
    });
  });

  test("a wrapper _layering: replace under a merge run replaces that section alone, and never reaches the file", async () => {
    const top = tempLayer("top.yml", {
      labels: { _layering: "replace", entries: [{ name: "only", color: "000000" }] },
      rulesets: [{ name: "tags", target: "tag" }],
    });
    setMergeEnv([layer("fleet.yml"), top]);
    expect(await run({ api: new MockApi({}), io: testIo })).toBe(0);
    expect(parseYaml(readFileSync(mergedFile, "utf8"))).toEqual({
      repository: { has_wiki: false, has_projects: false },
      labels: { _undeclared: "delete", entries: [{ name: "only", color: "000000" }] },
      rulesets: { _undeclared: "keep", entries: [FLEET_RULESET, { name: "tags", target: "tag" }] },
      pages: { build_type: "workflow", source: { branch: "main", path: "/" } },
    });
  });

  test("a top-level _layering: replace governs every keyed section of its layer and is consumed", async () => {
    const top = tempLayer("top.yml", {
      _layering: "replace",
      labels: [{ name: "only", color: "000000" }],
      rulesets: [{ name: "main", rules: [{ type: "non_fast_forward" }] }],
    });
    setMergeEnv([layer("fleet.yml"), top]);
    expect(await run({ api: new MockApi({}), io: testIo })).toBe(0);
    expect(parseYaml(readFileSync(mergedFile, "utf8"))).toEqual({
      repository: { has_wiki: false, has_projects: false },
      labels: { _undeclared: "delete", entries: [{ name: "only", color: "000000" }] },
      rulesets: {
        _undeclared: "keep",
        entries: [{ name: "main", rules: [{ type: "non_fast_forward" }] }],
      },
      pages: { build_type: "workflow", source: { branch: "main", path: "/" } },
    });
  });

  test("a null inside a keyed entry is a merge marker too, announced against its layer", async () => {
    const bypass = [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }];
    const fleet = tempLayer("fleet.yml", {
      rulesets: [{ ...FLEET_RULESET, bypass_actors: bypass }],
    });
    const top = tempLayer("top.yml", { rulesets: [{ name: "main", bypass_actors: null }] });
    setMergeEnv([fleet, top]);
    expect(await run({ api: new MockApi({}), io: testIo })).toBe(0);
    expect(parseYaml(readFileSync(mergedFile, "utf8"))).toEqual({
      rulesets: { _undeclared: "keep", entries: [FLEET_RULESET] },
    });
    expect(captured).toEqual([
      `notice: ${top}: null removed rulesets[0].bypass_actors declared by a lower layer`,
      `merged 2 layer(s) into ${mergedFile}`,
      "result: merged",
    ]);
  });

  test.each([
    ["a mapping", { setting: true }],
    // A null on an unknown key is no opt-out marker: nothing known is being removed, so it is the same misspelling.
    ["null", null],
  ])(
    "a layer with an unknown top-level key set to %s fails naming the layer: a merge has no allowlist to tolerate it",
    async (_case, value) => {
      const top = tempLayer("top.yml", {
        future: value,
        rulesets: [{ name: "tags", target: "tag" }],
      });
      setMergeEnv([layer("fleet.yml"), top]);
      expect(await run({ api: new MockApi({}), io: testIo })).toBe(1);
      expect(existsSync(mergedFile)).toBe(false);
      expect(captured).toEqual([
        `error: unknown top-level section(s) in ${top}: future (known: ${SECTION_KEYS.join(", ")}). Fix the typo, or prefix private keys with "_", or set the "sections" input to limit processing`,
        "result: failed",
      ]);
    },
  );

  test("a sections allowlist is rejected before any layer is read, so the written document is never narrower than the fold", async () => {
    // An allowlist naming one of the three folded sections is refused up front rather than narrowing the file; the nonexistent layer path proves the
    // refusal precedes the read.
    setMergeEnv([layer("fleet.yml"), layer("repo.yml"), join(dir, "nope.yml")]);
    process.env.INPUT_SECTIONS = "labels";
    expect(await run({ api: new MockApi({}), io: testIo })).toBe(1);
    expect(existsSync(mergedFile)).toBe(false);
    expect(captured).toEqual([
      'error: the "sections" input(s) do not apply to mode: merge, which only folds the ' +
        "settings-file layers into merged-file: it never targets a repository, calls the GitHub " +
        "API, delivers a report, or narrows the sections it writes. Remove the input(s), or move " +
        "them to the apply or check step that runs the merged document",
      "result: failed",
    ]);
  });

  test("a cyclic layer (a YAML anchor that includes itself) is refused by the fold, naming the layer", async () => {
    // A self-referencing anchor under a private key parses to a cyclic object; standalone validation ignores the key, so the engine's boundary is
    // what refuses the layer.
    const top = join(dir, "top.yml");
    writeFileSync(top, ["_notes: &loop", "  self: *loop", "labels: []", ""].join("\n"));
    setMergeEnv([layer("fleet.yml"), top]);
    expect(await run({ api: new MockApi({}), io: testIo })).toBe(1);
    expect(existsSync(mergedFile)).toBe(false);
    expect(captured).toEqual([
      `error: layer "${top}": the document contains a reference cycle (a YAML anchor that includes itself); layers must be trees`,
      "result: failed",
    ]);
  });

  test("merge then apply: the written file applies exactly like the expected merged document", async () => {
    setMergeEnv([layer("fleet.yml"), layer("team.yml"), layer("repo.yml")]);
    expect(await run({ api: new MockApi({}), io: testIo })).toBe(0);
    const expectedFile = tempLayer("expected.yml", THREE_LAYERS_MERGED);

    const applyRun = async (settingsFile: string): Promise<MockApi> => {
      for (const key of ENV_KEYS) {
        delete process.env[key];
      }
      process.env.INPUT_TOKEN = "t";
      process.env.INPUT_MODE = "apply";
      process.env.INPUT_REPOSITORY = "o/r";
      process.env.GITHUB_REPOSITORY = "o/r";
      process.env.INPUT_SECTIONS = "repository,labels";
      process.env["INPUT_SETTINGS-FILE"] = settingsFile;
      const api = new MockApi({
        "GET /repos/o/r": { data: { has_wiki: true, description: "old" } },
        "GET /repos/o/r/labels?per_page=100&page=1": { data: [] },
      }).allowMutations("PATCH /repos/o/r", "POST /repos/o/r/labels");
      expect(await run({ api, io: testIo })).toBe(0);
      return api;
    };
    const fromMerged = await applyRun(mergedFile);
    const fromExpected = await applyRun(expectedFile);
    expect(fromMerged.mutations()).toEqual(fromExpected.mutations());
    expect(fromMerged.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PATCH /repos/o/r",
      "POST /repos/o/r/labels",
      "POST /repos/o/r/labels",
      "POST /repos/o/r/labels",
    ]);
  });
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
  let dir: string;
  let snapshotFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "snapshot-mode-"));
    snapshotFile = join(dir, "out", "snapshot.yml");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  /** A snapshot run's env: the token, the target, the file, the labels allowlist. */
  function setSnapshotEnv() {
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
  }

  const LABELS = [{ name: "bug", color: "d73a4a", description: "Something is broken" }];
  const labelsApi = () =>
    new MockApi({ "GET /repos/o/r/labels?per_page=100&page=1": { data: LABELS } });

  test("writes the live settings to snapshot-file and publishes the snapshot result", async () => {
    setSnapshotEnv();
    const api = labelsApi();
    expect(await run({ api, io: testIo })).toBe(0);
    expect(api.mutations()).toEqual([]);
    expect(parseYaml(readFileSync(snapshotFile, "utf8"))).toEqual({
      labels: { _undeclared: "delete", entries: LABELS },
    });
    expect(outputs).toEqual({ "skipped-sections": "", result: "snapshot" });
    expect(captured).toEqual([`snapshot written to ${snapshotFile}`, "result: snapshot"]);
  });

  test("an apply-time input is rejected before any API call, and no file is written", async () => {
    setSnapshotEnv();
    process.env["INPUT_SETTINGS-FILE"] = "other.yml";
    const api = labelsApi();
    expect(await run({ api, io: testIo })).toBe(1);
    expect(api.calls).toEqual([]);
    expect(existsSync(snapshotFile)).toBe(false);
    expect(captured).toEqual([
      'error: the "settings-file" input(s) do not apply to mode: snapshot, which only reads the ' +
        "target repositories' live settings into snapshot-file or snapshot-dir: it applies no " +
        "document, folds no layers, and delivers no report. Remove the input(s), or move them to " +
        "the apply, check, or merge step they belong to",
      "result: failed",
    ]);
  });

  test("snapshot then check: the written file checks clean against the live state it was read from", async () => {
    setSnapshotEnv();
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
  });
});
