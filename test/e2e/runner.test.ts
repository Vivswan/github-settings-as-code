import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "neverthrow";
import { stringify as stringifyYaml } from "yaml";
import { parseRecipient } from "../../src/report/artifact-report.js";
import type { RerunCapture } from "./apply-idempotence-proof.js";
import { ARTIFACT_TEST_RECIPIENT } from "./generators.js";
import type { LoggedRequest } from "./mock/contract.js";
import {
  bundleBuildParityFailure,
  checkLeaks,
  declaredBuildBundleScript,
  exitCodeFailure,
  failureArtifacts,
  forbiddenPresent,
  indentedStdout,
  isSubsequence,
  markReportTitle,
  parseGithubOutput,
  parseSummaryOutcomes,
  requestLogFailures,
  roundTripFailures,
  type ScenarioReport,
  setReplay,
  snapshotCheckInputs,
  stripDebugLines,
  stripMaskLines,
  writtenSnapshotLeaks,
  writtenSnapshotPaths,
  yamlStrings,
} from "./runner.js";
import type { Scenario } from "./schema.js";

describe("writtenSnapshotPaths (the documents a snapshot run left behind)", () => {
  test("the dir form lists every .yml under the directory, relative to the temp dir, sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "written-snapshots-"));
    try {
      mkdirSync(join(dir, "snapshots", "acme"), { recursive: true });
      writeFileSync(join(dir, "snapshots", "acme", "svc-b.yml"), "labels: {}\n");
      writeFileSync(join(dir, "snapshots", "acme", "svc-a.yml"), "labels: {}\n");
      // A file outside the snapshot dir (the scenario's own settings.yml) is not a written snapshot.
      writeFileSync(join(dir, "settings.yml"), "{}\n");
      expect(writtenSnapshotPaths({ mode: "snapshot", snapshot_dir: "snapshots" }, dir)).toEqual([
        join("snapshots", "acme", "svc-a.yml"),
        join("snapshots", "acme", "svc-b.yml"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the file form lists the one file when the run wrote it, nothing when it did not", () => {
    const dir = mkdtempSync(join(tmpdir(), "written-snapshots-"));
    try {
      const inputs = { mode: "snapshot" as const, snapshot_file: "snapshot.yml" };
      expect(writtenSnapshotPaths(inputs, dir)).toEqual([]);
      writeFileSync(join(dir, "snapshot.yml"), "labels: {}\n");
      expect(writtenSnapshotPaths(inputs, dir)).toEqual(["snapshot.yml"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run without a snapshot destination wrote none", () => {
    expect(writtenSnapshotPaths({ mode: "apply" }, "/nonexistent")).toEqual([]);
  });
});

describe("writtenSnapshotLeaks (the secret sweep over the written documents)", () => {
  // The negative control for the sweep: a resolved secret value planted into a written document
  // must fail, naming the document and the value, while the clean sibling stays quiet.
  test("a planted secret value in a written document is a leak; a clean document is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "written-snapshots-"));
    try {
      mkdirSync(join(dir, "snapshots", "acme"), { recursive: true });
      const clean = join("snapshots", "acme", "clean.yml");
      const planted = join("snapshots", "acme", "planted.yml");
      writeFileSync(
        join(dir, clean),
        "actions_variables:\n  entries:\n    - name: A\n      value: $A\n",
      );
      writeFileSync(
        join(dir, planted),
        "actions_variables:\n  entries:\n    - name: A\n      value: hunter2-resolved\n",
      );
      expect(writtenSnapshotLeaks(dir, [clean, planted], ["hunter2-resolved", "ghp_e2e"])).toEqual([
        `leak: "hunter2-resolved" present in the written snapshot ${planted}`,
      ]);
      expect(writtenSnapshotLeaks(dir, [clean], ["hunter2-resolved"])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A multi-line value serializes as a block scalar: "|-" then one indented line per source line,
  // so the raw text never contains the value whole. Written through the same emitter the action uses.
  test("a planted multi-line value, wrapped as a block scalar, is still a leak", () => {
    const dir = mkdtempSync(join(tmpdir(), "written-snapshots-"));
    try {
      const secret = "line one of the key\nline two of the key";
      const path = "snapshot.yml";
      const text = stringifyYaml({ webhooks: { entries: [{ url: "https://x", secret }] } });
      writeFileSync(join(dir, path), text);
      expect(text).not.toContain(secret);
      expect(text).toContain("|-");
      expect(writtenSnapshotLeaks(dir, [path], [secret])).toEqual([
        `leak: "${secret}" present in the written snapshot ${path}`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a document that does not parse as YAML fails on its own instead of passing the sweep silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "written-snapshots-"));
    try {
      writeFileSync(join(dir, "broken.yml"), "labels: [unclosed\n");
      const failures = writtenSnapshotLeaks(dir, ["broken.yml"], ["hunter2"]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/^the written snapshot broken.yml is not parseable YAML: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("yamlStrings (every key and string leaf of a document)", () => {
  test("walks mappings, sequences, and scalars, keeping keys and skipping non-strings", () => {
    expect(
      yamlStrings({
        labels: {
          entries: [{ name: "bug", color: 1, on: true, note: null }],
          _undeclared: "delete",
        },
      }),
    ).toEqual(["labels", "entries", "name", "bug", "color", "on", "note", "_undeclared", "delete"]);
    expect(yamlStrings(null)).toEqual([]);
    expect(yamlStrings("top")).toEqual(["top"]);
  });
});

describe("roundTripFailures (the snapshot round trip's verdict)", () => {
  const clean = {
    exitCode: 0,
    outputs: { result: "clean" },
    summary: "",
    stdout: "",
    stderr: "",
    killedByHarness: false,
  };
  const write: LoggedRequest = {
    method: "POST",
    pathname: "/repos/o/r/labels",
    query: "",
    status: 201,
  };
  const read: LoggedRequest = {
    method: "GET",
    pathname: "/repos/o/r/labels",
    query: "",
    status: 200,
  };
  test.each<
    [
      label: string,
      check: typeof clean,
      requests: LoggedRequest[],
      violations: string[],
      want: string[],
    ]
  >([
    ["a clean check with only reads is no failure", clean, [read], [], []],
    [
      "a drifted check fails on its exit code and its result",
      { ...clean, exitCode: 1, outputs: { result: "drift" } },
      [read],
      [],
      [
        "snapshot round trip[s.yml]: the check exited 1, expected 0",
        'snapshot round trip[s.yml]: the check\'s result is "drift", expected "clean"',
      ],
    ],
    [
      "a write during the check is named, and so is the barrier violation it trips",
      clean,
      [read, write],
      ["request POST /repos/o/r/labels is a write in check mode"],
      [
        "snapshot round trip[s.yml]: the check wrote 1 time(s): POST /repos/o/r/labels",
        "snapshot round trip[s.yml]: mock violations:\n  request POST /repos/o/r/labels is a write in check mode",
      ],
    ],
    [
      "a harness kill is marked on the exit-code failure",
      { ...clean, exitCode: 143, killedByHarness: true },
      [],
      [],
      [
        "snapshot round trip[s.yml]: the check exited 143, expected 0 (the harness killed the child after 300000ms)",
      ],
    ],
  ])("%s", (_label, check, requests, violations, want) => {
    expect(roundTripFailures("snapshot round trip[s.yml]", check, requests, violations)).toEqual(
      want,
    );
  });
});

describe("snapshotCheckInputs (the round-trip check's inputs)", () => {
  test("carries every input the snapshot set, drops both destinations, and switches the mode", () => {
    // private_report at its default is legal in snapshot mode and outside the
    // three inputs the check once allowlisted: only derivation by exclusion keeps it.
    expect(
      snapshotCheckInputs({
        mode: "snapshot",
        snapshot_file: "snapshot.yml",
        snapshot_dir: "snapshots",
        sections: "labels,webhooks",
        on_missing_permission: "warn",
        private_repos: "show",
        private_report: "none",
      }),
    ).toEqual({
      mode: "check",
      sections: "labels,webhooks",
      on_missing_permission: "warn",
      private_repos: "show",
      private_report: "none",
    });
  });

  test("a scenario with only the destination yields a bare check run", () => {
    expect(snapshotCheckInputs({ mode: "snapshot", snapshot_file: "snapshot.yml" })).toEqual({
      mode: "check",
    });
  });
});

describe("bundle build parity (harness vs production)", () => {
  test("the declared build:bundle script matches what the harness builds", () => {
    // A unit test on purpose: a package.json-only diff selects no sections and skips the e2e smoke
    // job, so this is the only place the pin can fire on the PR that trips it.
    expect(bundleBuildParityFailure(declaredBuildBundleScript())).toBeUndefined();
  });

  test("a drifted or a missing script is a failure that names the script it saw", () => {
    const drifted = "bun build src/main.ts --target=node --minify --outfile lib/index.js";
    expect(bundleBuildParityFailure(drifted)).toContain(drifted);
    expect(bundleBuildParityFailure(undefined)).toBeDefined();
  });
});

describe("ARTIFACT_TEST_RECIPIENT", () => {
  test("is a valid age recipient the action's config validation accepts", () => {
    // If this constant ever stops parsing, every artifact-delivery scenario would silently fall into
    // the config-rejection path instead.
    expect(parseRecipient(ARTIFACT_TEST_RECIPIENT)).toEqual(ok());
  });
});

describe("exitCodeFailure (expect.exit_code membership)", () => {
  const cases: Array<[string, number, number | number[], string | undefined]> = [
    ["a matching plain-number expectation passes", 0, 0, undefined],
    ["a plain-number mismatch keeps the single-code message", 1, 0, "exit code 1 != expected 0"],
    ["an allowed-set member passes", 1, [0, 1], undefined],
    ["an exit outside the allowed set names the whole set", 2, [0, 1], "exit code 2 not in [0, 1]"],
    // The fuzz expectation is spread from a Set whose insertion order varies by seed; the failure text must not.
    [
      "the multi-element message renders sorted, whatever the set order",
      2,
      [1, 0],
      "exit code 2 not in [0, 1]",
    ],
    // The fuzz oracle often predicts exactly one legal exit; the message must stay byte-identical to
    // the plain-number form either way it is spelled.
    ["a one-element set keeps the single-code message", 1, [0], "exit code 1 != expected 0"],
  ];
  for (const [name, exitCode, expected, want] of cases) {
    test(name, () => {
      expect(exitCodeFailure(exitCode, expected)).toBe(want);
    });
  }
});

describe("parseGithubOutput", () => {
  test("reads simple name=value lines", () => {
    expect(parseGithubOutput("result=applied\nskipped-sections=teams\n")).toEqual({
      result: "applied",
      "skipped-sections": "teams",
    });
  });

  test("reads the @actions/core heredoc block", () => {
    const out = parseGithubOutput(
      ["result<<ghadelimiter_abc", "line one", "line two", "ghadelimiter_abc", ""].join("\n"),
    );
    expect(out.result).toBe("line one\nline two");
  });

  test("mixes heredoc and simple forms", () => {
    const out = parseGithubOutput(
      ["result=drift", "repos-result<<ghadelimiter_x", "{}", "ghadelimiter_x"].join("\n"),
    );
    expect(out).toEqual({ result: "drift", "repos-result": "{}" });
  });

  test("ignores blank and malformed lines", () => {
    expect(parseGithubOutput("\n=orphan\nresult=clean\n")).toEqual({ result: "clean" });
  });
});

describe("parseSummaryOutcomes", () => {
  test("extracts key -> status from the section table rows", () => {
    const summary = [
      "## github-settings-as-code (apply)",
      "",
      "| Section | Status | Detail |",
      "|---|---|---|",
      '| labels | :white_check_mark: applied | created label "bug" |',
      "| teams | :fast_forward: skipped | - |",
      "| rulesets | :warning: drift | rulesets[x]: ... |",
    ].join("\n");
    expect(parseSummaryOutcomes(summary)).toEqual({
      labels: "applied",
      teams: "skipped",
      rulesets: "drift",
    });
  });
});

describe("isSubsequence (mutations matcher)", () => {
  const log = [
    "PATCH /repos/o/r/labels/bug",
    "POST /repos/o/r/labels",
    "DELETE /repos/o/r/labels/wontfix",
  ];
  const cases: Array<[string, string[], string[], boolean]> = [
    ["empty patterns always match", [], log, true],
    ["exact in order", ["PATCH /repos/o/r/labels/bug", "POST /repos/o/r/labels"], log, true],
    ["prefix match, gaps allowed", ["PATCH /repos/o/r/labels", "DELETE /repos/o/r"], log, true],
    ["wrong order fails", ["POST /repos/o/r/labels", "PATCH /repos/o/r/labels/bug"], log, false],
    ["a missing pattern fails", ["PUT /repos/o/r/topics"], log, false],
    [
      "more patterns than log fails",
      ["POST /repos/o/r/labels", "POST /repos/o/r/labels"],
      log,
      false,
    ],
  ];
  for (const [name, patterns, entries, want] of cases) {
    test(name, () => {
      expect(isSubsequence(patterns, entries)).toBe(want);
    });
  }
});

describe("forbiddenPresent (never matcher)", () => {
  const log = ["GET /repos/o/r/labels", "POST /repos/o/r/labels"];
  const cases: Array<[string, string[], string[]]> = [
    ["nothing forbidden present", ["DELETE /repos/o/r/labels"], []],
    ["a present prefix is reported", ["POST /repos/o/r/labels"], ["POST /repos/o/r/labels"]],
    ["a shorter prefix still matches", ["POST /repos/o/r"], ["POST /repos/o/r"]],
  ];
  for (const [name, patterns, want] of cases) {
    test(name, () => {
      expect(forbiddenPresent(patterns, log)).toEqual(want);
    });
  }
});

describe("requestLogFailures (the request-log rules over recorded requests)", () => {
  // Recorded requests keep pathname and query apart; the rules decide which spelling each matches. A `never` pattern
  // carrying a query must fail against a request that carries that query, and stay clear of a sibling query on the
  // same path, or the quiet-path scenarios' `GET .../issues?state=all` guards would be always-green.
  const recorded: LoggedRequest[] = [
    {
      method: "GET",
      pathname: "/repos/o/r/issues",
      query: "state=open&labels=m&per_page=100&page=1",
      status: 200,
    },
    { method: "PATCH", pathname: "/repos/o/r/issues/7", query: "", status: 200 },
  ];
  const cases: Array<[string, Parameters<typeof requestLogFailures>[0], string[]]> = [
    [
      "a never pattern with the recorded query",
      { never: ["GET /repos/o/r/issues?state=open"] },
      ["forbidden request present: GET /repos/o/r/issues?state=open"],
    ],
    [
      "a never pattern with a sibling query stays clear",
      { never: ["GET /repos/o/r/issues?state=all"] },
      [],
    ],
    [
      "a never pattern without a query still forbids the path",
      { never: ["GET /repos/o/r/issues"] },
      ["forbidden request present: GET /repos/o/r/issues"],
    ],
    ["mutations match the write by path alone", { mutations: ["PATCH /repos/o/r/issues/7"] }, []],
    ["requests_contain sees the query", { requests_contain: ["page=1"] }, []],
    [
      "requests_contain misses an absent query",
      { requests_contain: ["page=2"] },
      ["no request contains: page=2"],
    ],
  ];
  for (const [name, exp, want] of cases) {
    test(name, () => {
      expect(requestLogFailures(exp, recorded)).toEqual(want);
    });
  }

  // The `{repo}` placeholder must expand in EVERY request-path list: a list left unexpanded is
  // always-red under `requests_contain` and always-green under `never`, and no scenario would notice.
  const onAdminRepo: LoggedRequest[] = [
    { method: "GET", pathname: "/repos/e2e-owner/e2e-repo/labels", query: "", status: 200 },
    { method: "POST", pathname: "/repos/e2e-owner/e2e-repo/labels", query: "", status: 201 },
  ];
  test.each<[label: string, exp: Parameters<typeof requestLogFailures>[0], want: string[]]>([
    ["mutations", { mutations: ["POST /repos/{repo}/labels"] }, []],
    ["requests_contain", { requests_contain: ["GET /repos/{repo}/labels"] }, []],
    [
      "never",
      { never: ["GET /repos/{repo}/labels"] },
      ["forbidden request present: GET /repos/e2e-owner/e2e-repo/labels"],
    ],
  ])("{repo} expands to the mock's owner/name under %s", (_label, exp, want) => {
    expect(requestLogFailures(exp, onAdminRepo)).toEqual(want);
  });
});

describe("stripMaskLines", () => {
  test("drops ::add-mask:: lines and keeps everything else", () => {
    const stdout = [
      "::add-mask::acme/secret-repo",
      "::error::private repository #1: failed",
      "result: failed",
    ].join("\n");
    const stripped = stripMaskLines(stdout);
    expect(stripped).not.toContain("acme/secret-repo");
    expect(stripped).toContain("private repository #1: failed");
    expect(stripped).toContain("result: failed");
  });
});

describe("indentedStdout (what --print-stdout echoes)", () => {
  // The Actions runner registers a mask only from a column-zero command, so the indented echo gets
  // no masking from it: every value a mask line named must already read `***` in the echo.
  test.each([
    [
      "mask lines dropped, the rest indented",
      "::add-mask::abc\nresult: clean\n::add-mask::acme/secret-repo\nrepository: 1 op\n",
      "        result: clean\n        repository: 1 op",
    ],
    [
      "a masked value on a later line prints as ***",
      "::add-mask::secret\nvalue: secret\n",
      "        value: ***",
    ],
    [
      "a value masked after it printed is redacted too",
      "value: secret\n::add-mask::secret\n",
      "        value: ***",
    ],
    [
      "a value containing another masked value is redacted whole",
      "::add-mask::acme\n::add-mask::acme/secret-repo\nrepository: acme/secret-repo by acme\n",
      "        repository: *** by ***",
    ],
    [
      "two values crossing in the text leave no fragment",
      "::add-mask::ABC\n::add-mask::BCD\nvalue: ABCD\n",
      "        value: ***",
    ],
    [
      "a value overlapping itself leaves no fragment",
      "::add-mask::aba\nvalue: ababa\n",
      "        value: ***",
    ],
    [
      "an annotation carries the value command-encoded, and that spelling is redacted too",
      "::add-mask::line1%0Aline2%25tail\n::error::value: line1%0Aline2%25tail\n",
      "        ::error::value: ***",
    ],
    [
      "the mask's %0A and %25 encoding is decoded, so a value spanning lines is found",
      "::add-mask::a%0Ab%25c\nvalue: a\nb%c\n",
      "        value: ***",
    ],
    [
      "CRLF stdout: the line's CR is not part of the value",
      "::add-mask::secret\r\nvalue: secret\r\n",
      "        value: ***",
    ],
    [
      "a value's regex-special characters match literally only",
      "::add-mask::a.b*\nvalue: a.b* not axbbb\n",
      "        value: *** not axbbb",
    ],
    ["stdout that is only mask lines echoes nothing", "::add-mask::abc\n", ""],
    [
      "an empty mask value redacts nothing",
      "::add-mask::\nresult: clean\n",
      "        result: clean",
    ],
  ])("%s", (_label, stdout, want) => {
    expect(indentedStdout(stdout)).toBe(want);
  });
});

describe("stripDebugLines (counterfactual rendered-surface guard)", () => {
  test("a canary only in a ::debug:: trace does NOT survive - so it cannot satisfy the counterfactual", () => {
    const stdout = [
      '::debug::POST /repos/o/r/labels payload: {"name":"CANARY-42"}',
      "::debug::GET /repos/o/r/labels -> 200",
    ].join("\n");
    expect(stripDebugLines(stdout)).not.toContain("CANARY-42");
  });

  test("a canary in a rendered (non-debug) line survives", () => {
    const stdout = [
      '::debug::POST /repos/o/r/labels payload: {"name":"CANARY-42"}',
      'o/r: labels: updated label "CANARY-42"',
    ].join("\n");
    const rendered = stripDebugLines(stdout);
    expect(rendered).not.toContain("payload");
    expect(rendered).toContain('updated label "CANARY-42"');
  });
});

describe("checkLeaks (redaction leak invariant)", () => {
  test("no forbidden string anywhere is clean", () => {
    const observed = {
      summary: "| private repository #1 | remote | applied |",
      stdout: "::add-mask::acme/secret\nresult: applied",
      stderr: "",
      outputs: { "repos-result": '{"private repository #1":{"result":"applied"}}' },
    };
    expect(checkLeaks(observed, ["acme/secret", "CANARY-1"])).toEqual([]);
  });

  test("a slug in the summary is a leak", () => {
    const observed = {
      summary: "| acme/secret | remote | applied |",
      stdout: "",
      stderr: "",
      outputs: {},
    };
    expect(checkLeaks(observed, ["acme/secret"])).toEqual([
      'leak: "acme/secret" present in the step summary',
    ]);
  });

  test("a canary in stdout outside the mask directive is a leak", () => {
    const observed = {
      summary: "",
      stdout: "::add-mask::acme/secret\n::debug::CANARY-1 slipped out",
      stderr: "",
      outputs: {},
    };
    expect(checkLeaks(observed, ["CANARY-1"])).toEqual([
      'leak: "CANARY-1" present in stdout (after stripping ::add-mask:: lines)',
    ]);
  });

  test("a slug on stderr is a leak (the run log captures stderr too)", () => {
    const observed = {
      summary: "",
      stdout: "",
      stderr: "::add-mask::acme/secret\nTrace: request to acme/secret failed",
      outputs: {},
    };
    expect(checkLeaks(observed, ["acme/secret"])).toEqual([
      'leak: "acme/secret" present in stderr (after stripping ::add-mask:: lines)',
    ]);
  });

  test("a slug in an output value is a leak", () => {
    const observed = {
      summary: "",
      stdout: "",
      stderr: "",
      outputs: { "repos-result": '{"acme/secret":{"result":"applied"}}' },
    };
    expect(checkLeaks(observed, ["acme/secret"])).toEqual([
      'leak: "acme/secret" present in the "repos-result" output',
    ]);
  });
});

describe("setReplay (nightly issue report contract)", () => {
  test("swaps the fuzzer's command into the block writeReport left under the title, nothing else moves", () => {
    const dir = mkdtempSync(join(tmpdir(), "set-replay-"));
    try {
      const written = [
        "# fuzz-42",
        "",
        "## Replay",
        "",
        "```sh",
        "bun test/e2e/run.ts --scenario fuzz-42",
        "```",
        "",
        "## Failures",
        "",
        "- exit code 1 != expected 0",
        "",
        "Exit code: 1",
        "",
      ];
      writeFileSync(join(dir, "report.md"), written.join("\n"));
      setReplay(dir, "bun test/e2e/fuzz.ts --seed 42 --iterations 1");
      const expected = [...written];
      expected[5] = "bun test/e2e/fuzz.ts --seed 42 --iterations 1";
      expect(readFileSync(join(dir, "report.md"), "utf8").split("\n")).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a report without the block under its title is a bug, not a silent insert", () => {
    const dir = mkdtempSync(join(tmpdir(), "set-replay-"));
    try {
      writeFileSync(join(dir, "report.md"), "# fuzz-42\n\n## Failures\n\n- leak\n");
      expect(() => setReplay(dir, "bun test/e2e/fuzz.ts --seed 42 --iterations 1")).toThrow(
        /carries no replay block under its title/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("markReportTitle (counterfactual disambiguation)", () => {
  test("appends the marker to the title line only", () => {
    const dir = mkdtempSync(join(tmpdir(), "mark-title-"));
    try {
      writeFileSync(join(dir, "report.md"), "# fuzz-multi-42\n\n## Failures\n\n- leak\n");
      markReportTitle(dir, "redaction counterfactual");
      const lines = readFileSync(join(dir, "report.md"), "utf8").split("\n");
      expect(lines[0]).toBe("# fuzz-multi-42 (redaction counterfactual)");
      expect(lines.slice(1)).toEqual(["", "## Failures", "", "- leak", ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("failureArtifacts (a verdict the runner did not reach)", () => {
  const scenario: Scenario = {
    name: "fuzz-oracle-42",
    tiers: ["mock"],
    settings: {},
    inputs: {},
    denial_style: "fine_grained",
    owner_kind: "org",
    expect: { exit_code: 0 },
  };
  const passed: ScenarioReport = {
    scenario: scenario.name,
    ok: true,
    failures: [],
    exitCode: 0,
    outputs: {},
    summary: "",
    stdout: "",
    stderr: "",
    requests: [],
    faultsFired: {},
    reposResult: {},
    reruns: [],
  };

  test("a run the runner passed but a caller failed gets a report.md listing the caller's failures", () => {
    const dir = failureArtifacts(scenario, passed, [
      'branches: observed "failed" not in predicted {clean,drift}',
    ]);
    expect(dir).toBeDefined();
    try {
      const lines = readFileSync(join(dir as string, "report.md"), "utf8").split("\n");
      // Every artifact opens with a replay a curated failure can run as is; the fuzzer overwrites the command.
      expect(lines.slice(0, 7)).toEqual([
        "# fuzz-oracle-42",
        "",
        "## Replay",
        "",
        "```sh",
        "bun test/e2e/run.ts --scenario fuzz-oracle-42",
        "```",
      ]);
      expect(lines).toContain('- branches: observed "failed" not in predicted {clean,drift}');
      // The same directory the runner's own dump writes, so the fuzz-issue action's upload step finds it.
      expect(dir).toContain(join("test", "e2e", ".artifacts"));
    } finally {
      rmSync(dir as string, { recursive: true, force: true });
    }
  });

  test("no failures means no directory, and the runner's own dump is never duplicated", () => {
    expect(failureArtifacts(scenario, passed, [])).toBeUndefined();
    const dumped = { ...passed, ok: false, artifactDir: "/already/dumped" };
    expect(failureArtifacts(scenario, dumped, [])).toBe("/already/dumped");
  });

  test("each re-run's surfaces land in their own subdirectory, with only that re-run's requests", () => {
    const primaryRequest: LoggedRequest = {
      method: "GET",
      pathname: "/repos/o/r/labels",
      query: "",
      status: 200,
    };
    const rerunRequest: LoggedRequest = {
      method: "GET",
      pathname: "/repos/o/r",
      query: "",
      status: 200,
    };
    const rerun: RerunCapture = {
      label: "snapshot check snapshots/o/r.yml",
      stdout: "rerun stdout",
      stderr: "rerun stderr",
      summary: "| labels | :white_check_mark: clean | |",
      outputs: { result: "drift" },
      requests: [rerunRequest],
    };
    const report: ScenarioReport = {
      ...passed,
      ok: false,
      failures: [
        'snapshot round trip[snapshots/o/r.yml]: the check\'s result is "drift", expected "clean"',
      ],
      requests: [primaryRequest, rerunRequest],
      reruns: [rerun],
    };
    const dir = failureArtifacts(scenario, report, report.failures);
    expect(dir).toBeDefined();
    try {
      // The label is sanitized like the scenario name, so a path-shaped label stays inside the artifact dir.
      const sub = join(dir as string, "rerun-0-snapshot-check-snapshots-o-r-yml");
      expect(existsSync(sub)).toBe(true);
      expect(readFileSync(join(sub, "stdout.txt"), "utf8")).toBe("rerun stdout");
      expect(readFileSync(join(sub, "stderr.txt"), "utf8")).toBe("rerun stderr");
      expect(readFileSync(join(sub, "summary.md"), "utf8")).toBe(rerun.summary);
      expect(JSON.parse(readFileSync(join(sub, "requests.json"), "utf8"))).toEqual([rerunRequest]);
      // The primary dump is unchanged: the full log at the top, the primary surfaces beside it.
      expect(JSON.parse(readFileSync(join(dir as string, "requests.json"), "utf8"))).toEqual(
        report.requests,
      );
      expect(readFileSync(join(dir as string, "stdout.txt"), "utf8")).toBe("");
    } finally {
      rmSync(dir as string, { recursive: true, force: true });
    }
  });

  test.each<[label: string, runnerFailures: string[], callerFailures: string[], listed: string[]]>([
    [
      "a caller failure on top of the runner's",
      ["exit code 1 != expected 0"],
      ["exit code 1 != expected 0", "labels: observed skipped, predicted failed"],
      ["- exit code 1 != expected 0", "- labels: observed skipped, predicted failed"],
    ],
    [
      "a duplicated runner failure beside a new caller failure",
      ["leak", "leak"],
      ["oracle: drift predicted"],
      ["- leak", "- oracle: drift predicted"],
    ],
  ])(
    "%s is merged into the existing report.md, deduplicated",
    (_label, runnerFailures, callerFailures, listed) => {
      const dir = mkdtempSync(join(tmpdir(), "failure-artifacts-"));
      try {
        writeFileSync(join(dir, "report.md"), "# stale\n");
        const dumped: ScenarioReport = {
          ...passed,
          ok: false,
          exitCode: 1,
          failures: runnerFailures,
          artifactDir: dir,
        };
        expect(failureArtifacts(scenario, dumped, callerFailures)).toBe(dir);
        const lines = readFileSync(join(dir, "report.md"), "utf8").split("\n");
        expect(lines[0]).toBe("# fuzz-oracle-42");
        expect(lines.filter((line) => line.startsWith("- "))).toEqual(listed);
        expect(lines).toContain("Exit code: 1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("the runner's own failures alone leave its report.md untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "failure-artifacts-"));
    try {
      writeFileSync(join(dir, "report.md"), "# the runner's own\n");
      const dumped: ScenarioReport = { ...passed, ok: false, failures: ["leak"], artifactDir: dir };
      expect(failureArtifacts(scenario, dumped, ["leak"])).toBe(dir);
      expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("# the runner's own\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
