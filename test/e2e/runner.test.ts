import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecipient } from "../../src/report/artifact-report.js";
import type { SectionKey } from "../../src/schema.js";
import {
  ALWAYS_REWRITE_ENDPOINT_FAMILIES,
  alwaysRewriteEndpointKeys,
  COMPARE_BEFORE_WRITE,
} from "./apply-idempotence.js";
import { ARTIFACT_TEST_RECIPIENT } from "./generators.js";
import type { LoggedRequest } from "./mock/routes.js";
import {
  changedFamilies,
  checkLeaks,
  exitCodeFailure,
  forbiddenPresent,
  insertReplay,
  isSubsequence,
  markReportTitle,
  missingSecondApplyRewrites,
  parseGithubOutput,
  parseSummaryOutcomes,
  recordUnconditionalWrites,
  secondApplyWriteFailures,
  stripDebugLines,
  stripMaskLines,
  type UnconditionalWriteWitness,
  unwitnessedUnconditionalSections,
} from "./runner.js";

describe("ARTIFACT_TEST_RECIPIENT", () => {
  test("is a valid age recipient the action's config validation accepts", () => {
    // The artifact scenarios pin this constant as the report-public-key; if it
    // ever stops parsing, every artifact-delivery scenario would silently fall
    // into the config-rejection path instead. Pin it against the same validator
    // the action uses at config parse.
    expect(parseRecipient(ARTIFACT_TEST_RECIPIENT)).toEqual({ ok: true });
  });
});

describe("exitCodeFailure (expect.exit_code membership)", () => {
  test("a matching plain-number expectation passes", () => {
    expect(exitCodeFailure(0, 0)).toBeUndefined();
  });

  test("a plain-number mismatch keeps the single-code message", () => {
    expect(exitCodeFailure(1, 0)).toBe("exit code 1 != expected 0");
  });

  test("an allowed-set member passes", () => {
    expect(exitCodeFailure(1, [0, 1])).toBeUndefined();
  });

  test("an exit outside the allowed set names the whole set", () => {
    expect(exitCodeFailure(2, [0, 1])).toBe("exit code 2 not in [0, 1]");
  });

  test("the multi-element message renders sorted, whatever the set order", () => {
    // The fuzz expectation is spread from a Set, whose insertion order varies
    // by seed; the failure text must not.
    expect(exitCodeFailure(2, [1, 0])).toBe("exit code 2 not in [0, 1]");
  });

  test("a one-element set keeps the single-code message", () => {
    // The fuzz oracle often predicts exactly one legal exit; the message must
    // stay byte-identical to the plain-number form either way it is spelled.
    expect(exitCodeFailure(1, [0])).toBe("exit code 1 != expected 0");
  });
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
      "## repo-settings-as-code (apply)",
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

  test("ignores the header and separator rows", () => {
    const summary = "| Section | Status | Detail |\n|---|---|---|\n";
    expect(parseSummaryOutcomes(summary)).toEqual({});
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
    [
      "prefix match, gaps allowed",
      ["PATCH /repos/o/r/labels/bug", "DELETE /repos/o/r/labels/wontfix"],
      log,
      true,
    ],
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
    ["empty patterns report nothing", [], []],
  ];
  for (const [name, patterns, want] of cases) {
    test(name, () => {
      expect(forbiddenPresent(patterns, log)).toEqual(want);
    });
  }
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

  test("a slug outside a mask directive survives (so a real leak is caught)", () => {
    // The mask directive is the ONLY line allowed to carry the raw slug; a slug
    // anywhere else must remain after stripping so checkLeaks can flag it.
    const stdout = ["::add-mask::acme/secret-repo", "::debug::acme/secret-repo leaked here"].join(
      "\n",
    );
    expect(stripMaskLines(stdout)).toContain("acme/secret-repo leaked here");
  });
});

describe("stripDebugLines (counterfactual rendered-surface guard)", () => {
  test("a canary only in a ::debug:: trace does NOT survive - so it cannot satisfy the counterfactual", () => {
    // The counterfactual must judge RENDERED output, not API traces. A canary
    // that appears solely in a debug request-trace line is stripped, so it would
    // NOT count as having surfaced under show - a rendered-detail suppression
    // regression is therefore still caught.
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
    expect(rendered).not.toContain("payload"); // the debug trace is gone
    expect(rendered).toContain('updated label "CANARY-42"'); // the rendered line stays
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

  test("the mask directive itself is not a leak", () => {
    const observed = { summary: "", stdout: "::add-mask::acme/secret", stderr: "", outputs: {} };
    expect(checkLeaks(observed, ["acme/secret"])).toEqual([]);
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

describe("always-rewrite lockstep (endpoint flag <-> mock state families)", () => {
  test("every alwaysRewrite endpoint declares its mock state family, and nothing else does", () => {
    // The required-rewrite obligation lives on the EndpointDecl (per
    // endpoint); the snapshot exclusion derives from the endpoint-to-family
    // mapping. Pinning the mapping's KEYS against the flags means a new
    // flagged endpoint fails here until it names its state family - even
    // when its section already carries another flagged endpoint.
    expect(alwaysRewriteEndpointKeys()).toEqual(
      Object.keys(ALWAYS_REWRITE_ENDPOINT_FAMILIES).sort(),
    );
    // The mapping itself, pinned literally: the families are mock storage
    // names (state.ts), which nothing can derive - a wrong family here would
    // silently stop stripping updated_at for that store.
    expect(ALWAYS_REWRITE_ENDPOINT_FAMILIES).toEqual({
      "actions_secrets.put": "actions_secrets",
      "dependabot_secrets.put": "dependabot_secrets",
      "codespaces_secrets.put": "codespaces_secrets",
      "environments.putSecret": "environment_secrets",
    });
  });
});

describe("secondApplyWriteFailures (apply-idempotence zero-write subset)", () => {
  const write = (method: string, pathname: string): LoggedRequest => ({
    method,
    pathname,
    query: "",
    status: 200,
  });

  test("a write to a compare-before-write section fires the assertion", () => {
    const failures = secondApplyWriteFailures([write("POST", "/repos/e2e-owner/e2e-repo/labels")]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"labels"');
    expect(failures[0]).toContain("compares before writing");
  });

  test("a write to an unconditional-PUT section passes", () => {
    // Rulesets and environments PUT existing resources on every apply, so a
    // second-apply write there is legitimate; only state stability binds them.
    expect(
      secondApplyWriteFailures([
        write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000"),
        write("PUT", "/repos/e2e-owner/e2e-repo/environments/production"),
      ]),
    ).toEqual([]);
  });

  test("a write matching no section endpoint fires the outside-section failure", () => {
    // Report traffic (the issue channel) is the realistic offender: an
    // idempotence re-run must not deliver a report at all.
    const failures = secondApplyWriteFailures([
      write("POST", "/repos/e2e-owner/svc-private/issues"),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("outside any section endpoint");
  });

  test("every compare-before-write section's own writes are flagged, per offender", () => {
    const failures = secondApplyWriteFailures([
      write("PATCH", "/repos/e2e-owner/e2e-repo/labels/bug"),
      write("POST", "/repos/e2e-owner/e2e-repo/milestones"),
      write("DELETE", "/repos/e2e-owner/e2e-repo/autolinks/1"),
      write("PUT", "/repos/e2e-owner/e2e-repo/collaborators/alice"),
      write("PUT", "/repos/e2e-owner/e2e-repo/actions/workflows/7/enable"),
    ]);
    expect(failures).toHaveLength(5);
  });
});

describe("missingSecondApplyRewrites (apply-idempotence always-rewrite subset)", () => {
  const write = (method: string, pathname: string): LoggedRequest => ({
    method,
    pathname,
    query: "",
    status: 200,
  });
  const secretPut = write("PUT", "/repos/e2e-owner/e2e-repo/actions/secrets/DEPLOY_TOKEN");

  test("a first-apply secret PUT the second apply skipped fires the assertion", () => {
    const failures = missingSecondApplyRewrites([secretPut], []);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("actions/secrets/DEPLOY_TOKEN");
    expect(failures[0]).toContain("re-written on EVERY apply");
  });

  test("a re-issued secret PUT passes; other sections' writes never bind", () => {
    // A rulesets PUT on the first run creates no re-write obligation - only
    // always-rewrite sections do.
    expect(
      missingSecondApplyRewrites(
        [secretPut, write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000")],
        [secretPut],
      ),
    ).toEqual([]);
  });

  test("a first-apply secret DELETE creates no re-write obligation", () => {
    // The purge direction is one-shot: the second apply sees no live secret
    // to delete, so only PUTs bind.
    expect(
      missingSecondApplyRewrites(
        [write("DELETE", "/repos/e2e-owner/e2e-repo/actions/secrets/STALE")],
        [],
      ),
    ).toEqual([]);
  });

  test("every family's sealed PUT binds: dependabot, codespaces, environment secrets", () => {
    // The obligation derives from the EndpointDecl alwaysRewrite flag, so a
    // skipped first-apply PUT fires for each family - and crucially, the
    // ENVIRONMENT PUT itself (same section, no flag) creates no obligation.
    const firstWrites = [
      write("PUT", "/repos/e2e-owner/e2e-repo/dependabot/secrets/REGISTRY_TOKEN"),
      write("PUT", "/repos/e2e-owner/e2e-repo/codespaces/secrets/DOTFILES_PAT"),
      write("PUT", "/repos/e2e-owner/e2e-repo/environments/prod"),
      write("PUT", "/repos/e2e-owner/e2e-repo/environments/prod/secrets/DEPLOY_KEY"),
    ];
    const failures = missingSecondApplyRewrites(firstWrites, []);
    expect(failures).toHaveLength(3);
    expect(failures.join("\n")).toContain("dependabot/secrets/REGISTRY_TOKEN");
    expect(failures.join("\n")).toContain("codespaces/secrets/DOTFILES_PAT");
    expect(failures.join("\n")).toContain("environments/prod/secrets/DEPLOY_KEY");
    expect(failures.join("\n")).not.toContain("environments/prod but");
  });
});

describe("unwitnessedUnconditionalSections (apply-idempotence corpus witness)", () => {
  const write = (method: string, pathname: string): LoggedRequest => ({
    method,
    pathname,
    query: "",
    status: 200,
  });
  /** A witness map with every false-listed section fully covered. */
  const coveredWitness = (): UnconditionalWriteWitness => {
    const witness: UnconditionalWriteWitness = new Map();
    for (const [section, compares] of Object.entries(COMPARE_BEFORE_WRITE)) {
      if (!compares) {
        witness.set(section as SectionKey, { first: 1, second: 1 });
      }
    }
    return witness;
  };

  test("a fully covered corpus produces no failures", () => {
    expect(unwitnessedUnconditionalSections(coveredWitness())).toEqual([]);
  });

  test("an empty corpus flags EVERY false-listed section as unwitnessed", () => {
    const failures = unwitnessedUnconditionalSections(new Map());
    const falseListed = Object.values(COMPARE_BEFORE_WRITE).filter((v) => !v).length;
    expect(failures).toHaveLength(falseListed);
    for (const failure of failures) {
      expect(failure).toContain("NO apply_idempotent scenario");
    }
  });

  test("first-apply writes without any second-apply write name the opposite remedy", () => {
    const witness = coveredWitness();
    witness.set("teams", { first: 2, second: 0 });
    const failures = unwitnessedUnconditionalSections(witness);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('"teams"');
    expect(failures[0]).toContain("never re-issued by any second apply");
  });

  test("recordUnconditionalWrites counts only false-listed sections, per side", () => {
    const witness: UnconditionalWriteWitness = new Map();
    recordUnconditionalWrites(
      witness,
      [
        // labels compares before writing, so it never enters the witness;
        // report traffic matches no section endpoint and is skipped too.
        write("POST", "/repos/e2e-owner/e2e-repo/labels"),
        write("POST", "/repos/e2e-owner/svc-private/issues"),
        write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000"),
      ],
      [write("PUT", "/repos/e2e-owner/e2e-repo/rulesets/90000000")],
    );
    expect([...witness.keys()]).toEqual(["rulesets"]);
    expect(witness.get("rulesets")).toEqual({ first: 1, second: 1 });
  });
});

describe("changedFamilies (apply-idempotence state stability)", () => {
  test("names exactly the families whose serialized state moved", () => {
    const before = new Map([
      ["state.labels", '[{"name":"bug"}]'],
      ["state.rulesets", "[]"],
    ]);
    const after = new Map([
      ["state.labels", "[]"],
      ["state.rulesets", "[]"],
    ]);
    expect(changedFamilies(before, after)).toEqual(["state.labels"]);
  });

  test("identical snapshots report no change", () => {
    const snap = new Map([["state.repo", '{"name":"x"}']]);
    expect(changedFamilies(snap, new Map(snap))).toEqual([]);
  });

  test("a family present on only one side counts as changed", () => {
    expect(changedFamilies(new Map(), new Map([["a/b.issues", "[]"]]))).toEqual(["a/b.issues"]);
    expect(changedFamilies(new Map([["a/b.issues", "[]"]]), new Map())).toEqual(["a/b.issues"]);
  });
});

describe("insertReplay (fuzz-issue report contract)", () => {
  test("puts the fenced replay block right after the title, inside the report head", () => {
    const dir = mkdtempSync(join(tmpdir(), "insert-replay-"));
    try {
      writeFileSync(
        join(dir, "report.md"),
        "# fuzz-42\n\n## Failures\n\n- exit code 1 != expected 0\n\nExit code: 1\n",
      );
      insertReplay(dir, "bun test/e2e/fuzz.ts --seed 42 --iterations 1");
      const lines = readFileSync(join(dir, "report.md"), "utf8").split("\n");
      expect(lines[0]).toBe("# fuzz-42");
      expect(lines.slice(1, 7)).toEqual([
        "",
        "## Replay",
        "",
        "```sh",
        "bun test/e2e/fuzz.ts --seed 42 --iterations 1",
        "```",
      ]);
      // The original body survives below the inserted section.
      expect(lines).toContain("## Failures");
      expect(lines).toContain("Exit code: 1");
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
