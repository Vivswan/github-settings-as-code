import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecipient } from "../../src/report/artifact-report.js";
import { ARTIFACT_TEST_RECIPIENT } from "./generators.js";
import {
  bundleBuildParityFailure,
  checkLeaks,
  declaredBuildBundleScript,
  exitCodeFailure,
  forbiddenPresent,
  insertReplay,
  isSubsequence,
  markReportTitle,
  parseGithubOutput,
  parseSummaryOutcomes,
  stripDebugLines,
  stripMaskLines,
} from "./runner.js";

describe("bundle build parity (harness vs production)", () => {
  test("the declared build:bundle script matches what the harness builds", () => {
    // The e2e children run a bundle the HARNESS builds, so a flag added to
    // build:bundle (minify, sourcemap, define) would ship an artifact e2e
    // never exercises. This assertion lives in a unit test on purpose: it is
    // the only place the pin can fire on the PR that trips it, since a
    // package.json-only diff selects no sections and skips the e2e smoke job.
    expect(bundleBuildParityFailure(declaredBuildBundleScript())).toBeUndefined();
  });

  test("a drifted or missing script is reported, naming both sides", () => {
    // The inverse leg: prove the check can fail at all, and that its message
    // carries the two commands a reader must reconcile.
    const drifted = bundleBuildParityFailure(
      "bun build src/main.ts --target=node --minify --outfile lib/index.js",
    );
    expect(drifted).toBeDefined();
    expect(drifted).toContain("--minify");
    expect(drifted).toContain("Bun.build");
    expect(bundleBuildParityFailure(undefined)).toBeDefined();
  });
});

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
  const cases: Array<[string, number, number | number[], string | undefined]> = [
    ["a matching plain-number expectation passes", 0, 0, undefined],
    ["a plain-number mismatch keeps the single-code message", 1, 0, "exit code 1 != expected 0"],
    ["an allowed-set member passes", 1, [0, 1], undefined],
    ["an exit outside the allowed set names the whole set", 2, [0, 1], "exit code 2 not in [0, 1]"],
    // The fuzz expectation is spread from a Set, whose insertion order varies
    // by seed; the failure text must not.
    [
      "the multi-element message renders sorted, whatever the set order",
      2,
      [1, 0],
      "exit code 2 not in [0, 1]",
    ],
    // The fuzz oracle often predicts exactly one legal exit; the message must
    // stay byte-identical to the plain-number form either way it is spelled.
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
