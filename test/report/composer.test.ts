import { describe, expect, test } from "bun:test";
import { composeReport, type ReportInput } from "../../src/report/composer.js";

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    target: "o/private-repo",
    adminRepo: "o/admin",
    runUrl: "https://github.com/o/admin/actions/runs/42",
    mode: "check",
    result: "drift",
    timestamp: "2026-07-22T10:00:00.000Z",
    outcomes: [
      { key: "labels", status: "drift", detail: ["labels[secret-project]: missing"] },
      { key: "repository", status: "clean", detail: [] },
    ],
    transcript: [
      { line: "labels: comparing 3 labels" },
      { level: "warning", line: "labels[secret-project]: missing" },
    ],
    ...overrides,
  };
}

describe("composeReport", () => {
  test("renders the run metadata, the outcome table, and the transcript", () => {
    // The timestamp is an input, so the whole document is deterministic.
    expect(composeReport(input())).toBe(
      [
        "# settings-as-code private report: o/private-repo",
        "",
        "Full, unredacted report for this target. The public run redacts it; this document is its private mirror.",
        "",
        "| | |",
        "|---|---|",
        "| Target | o/private-repo |",
        "| Admin repository | o/admin |",
        "| Run | https://github.com/o/admin/actions/runs/42 |",
        "| Mode | check |",
        "| Result | drift |",
        "| Generated | 2026-07-22T10:00:00.000Z |",
        "",
        "## Sections",
        "",
        "| Section | Status | Detail |",
        "|---|---|---|",
        "| labels | drift | labels[secret-project]: missing |",
        "| repository | clean |  |",
        "",
        "## Transcript",
        "",
        "```",
        "labels: comparing 3 labels",
        "[warning] labels[secret-project]: missing",
        "```",
        "",
      ].join("\n"),
    );
  });

  test("joins multi-line detail with <br> and escapes table pipes", () => {
    const report = composeReport(
      input({
        outcomes: [{ key: "labels", status: "failed", detail: ["a | b", "second line"] }],
      }),
    );
    expect(report).toContain("| labels | failed | a \\| b<br>second line |");
  });

  test("backslashes are escaped BEFORE pipes, so backslash-pipe cannot split a row", () => {
    // Without the backslash escape, "a\|b" renders as an escaped backslash followed by a LIVE pipe and the cell splits.
    const report = composeReport(
      input({
        outcomes: [{ key: "labels", status: "failed", detail: ["a\\|b", "line1\nline2"] }],
      }),
    );
    expect(report).toContain("| labels | failed | a\\\\\\|b<br>line1 line2 |");
  });

  test("a bare carriage return is a line ending too and is flattened", () => {
    // CommonMark treats a standalone CR as a line ending, so an unflattened "\r" would still split the table row.
    const report = composeReport(
      input({ outcomes: [{ key: "labels", status: "failed", detail: ["cr\ronly"] }] }),
    );
    expect(report).toContain("| labels | failed | cr only |");
  });

  test("a transcript containing code fences cannot break out of its block", () => {
    const report = composeReport(
      input({ transcript: [{ line: "```" }, { line: "````fenced````" }] }),
    );
    const fence = "`".repeat(5);
    expect(report).toContain(`${fence}\n\`\`\`\n\`\`\`\`fenced\`\`\`\`\n${fence}`);
  });

  test("empty outcomes and transcript render placeholders, not empty tables", () => {
    const report = composeReport(input({ outcomes: [], transcript: [] }));
    expect(report).toContain("No sections ran for this target.");
    expect(report).toContain("No output was captured for this target.");
    expect(report).not.toContain("| Section |");
  });
});
