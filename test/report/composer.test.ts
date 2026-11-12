import { describe, expect, test } from "bun:test";
import { composeReport, composeReportWithin, type ReportInput } from "../../src/report/composer.js";

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

  test.each<[name: string, detail: string[], cell: string]>([
    [
      "joins multi-line detail with <br> and escapes table pipes",
      ["a | b", "second line"],
      "a \\| b<br>second line",
    ],
    // Without the backslash escape, "a\|b" renders as an escaped backslash followed by a LIVE pipe and the cell splits.
    [
      "backslashes are escaped BEFORE pipes, so backslash-pipe cannot split a row",
      ["a\\|b", "line1\nline2"],
      "a\\\\\\|b<br>line1 line2",
    ],
    // CommonMark treats a standalone CR as a line ending, so an unflattened "\r" would still split the table row.
    ["a bare carriage return is a line ending too and is flattened", ["cr\ronly"], "cr only"],
  ])("%s", (_name, detail, cell) => {
    const report = composeReport(
      input({ outcomes: [{ key: "labels", status: "failed", detail }] }),
    );
    expect(report).toContain(`| labels | failed | ${cell} |`);
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

describe("composeReportWithin", () => {
  const detail = (section: string, count: number): string[] =>
    Array.from(
      { length: count },
      (_, i) => `${section}[entry-${i}]: undeclared, so apply deletes it`,
    );
  /** A drifted section whose transcript repeats its detail, as a check run's does. */
  const drifted = (count: number): ReportInput => {
    const lines = detail("labels", count);
    return input({
      outcomes: [{ key: "labels", status: "drift", detail: lines }],
      transcript: lines.map((line) => ({ line: `drift: ${line}` })),
    });
  };
  /** What a cut report says about itself: the counts in its head notice, and the count each mark carries. */
  const leftOut = (report: string) => ({
    head: /^\*\*Cut to fit (\d+) characters\.\*\* Lines left out: (\d+) of (\d+); /m
      .exec(report)
      ?.slice(1)
      .map(Number),
    marks: [...report.matchAll(/\(lines left out: (\d+)\)/g)].map((match) => Number(match[1])),
  });
  const transcriptOf = (report: string): string => report.slice(report.indexOf("## Transcript"));

  test("a report within the limit is the whole report, with no notice", () => {
    const report = drifted(5);
    const whole = composeReport(report);
    expect(composeReportWithin(report, whole.length)).toBe(whole);
    expect(leftOut(whole)).toEqual({ head: undefined, marks: [] });
  });

  test("one character over, the transcript is cut and every detail line stays; the head and the mark count the cut", () => {
    // Uncut, a body over the channel's limit is refused on every run, so the report is never delivered at all.
    const report = drifted(40);
    const whole = composeReport(report);
    const limit = whole.length - 1;
    const cut = composeReportWithin(report, limit);
    expect(cut.length).toBeLessThanOrEqual(limit);
    const row = (text: string) => text.split("\n").find((line) => line.startsWith("| labels |"));
    expect(row(cut)).toBe(row(whole) as string);
    const { head, marks } = leftOut(cut);
    expect(marks).toHaveLength(1);
    expect(head).toEqual([limit, marks[0] as number, 80]);
    // The transcript keeps its first lines, in order, under a closed fence; the mark stands below it.
    const kept = 40 - (marks[0] as number);
    expect(kept).toBeGreaterThan(0);
    expect(transcriptOf(cut)).toBe(
      [
        "## Transcript",
        "",
        "```",
        ...(report.transcript.slice(0, kept).map((entry) => entry.line) as string[]),
        "```",
        "",
        `(lines left out: ${marks[0]})`,
        "",
      ].join("\n"),
    );
  });

  test("when the detail alone is over the limit, sections take turns: a short section keeps its lines and the long one is cut", () => {
    // Spent section by section, a long first section would take the whole limit and a failed section's one line would be the one left out.
    const long = detail("labels", 60);
    const report = input({
      outcomes: [
        { key: "labels", status: "drift", detail: long },
        { key: "rulesets", status: "failed", detail: ["rulesets: 403 Forbidden"] },
      ],
      transcript: long.map((line) => ({ line })),
    });
    const limit = Math.floor(composeReport(report).length / 3);
    const cut = composeReportWithin(report, limit);
    expect(cut.length).toBeLessThanOrEqual(limit);
    expect(cut).toContain("| rulesets | failed | rulesets: 403 Forbidden |");
    const { head, marks } = leftOut(cut);
    // Two marks: the labels cell's, then the transcript's, which is left out whole and so has no fence.
    expect(marks).toHaveLength(2);
    expect(marks[1]).toBe(60);
    expect(head).toEqual([limit, (marks[0] as number) + 60, 121]);
    expect(cut).toContain(`${long[0]}<br>`);
    expect(cut).toContain(`<br>(lines left out: ${marks[0]}) |`);
    expect(transcriptOf(cut)).toBe("## Transcript\n\n(lines left out: 60)\n");
  });

  test("detail and transcript lines never push the body past the limit; the fixed part is not cut, so a limit below it is not met", () => {
    // One unpaid character in the fit is a refused body at some limit, so every limit up to the whole report is tried.
    const varied = (prefix: string): string[] =>
      Array.from({ length: 12 }, (_, i) => `${prefix}${"x".repeat((i * 7) % 23)}`);
    const report = input({
      outcomes: [
        { key: "labels", status: "drift", detail: ["a | b", "``` c", "", ...varied("d")] },
        { key: "repository", status: "clean", detail: [] },
        { key: "rulesets", status: "failed", detail: ["e\nf", ...varied("g")] },
      ],
      transcript: [
        { line: "```" },
        { level: "warning", line: "" },
        ...varied("h").map((line) => ({ line })),
      ],
    });
    // The fixed part is the body with all 42 lines left out: the heading, the notice, the run table, each section's
    // status, and the marks. Its length moves only with the digits of the limit its notice names.
    const fixedPart = (limit: number): number =>
      composeReportWithin(report, 0).length + String(limit).length - 1;
    const cuts = Array.from({ length: composeReport(report).length }, (_, limit) => {
      const cut = composeReportWithin(report, limit);
      const { head, marks } = leftOut(cut);
      return { limit, length: cut.length, head, left: marks.reduce((sum, n) => sum + n, 0) };
    });
    const limitsOf = (found: typeof cuts): number[] => found.map((cut) => cut.limit);
    const reachable = cuts.filter((cut) => cut.limit >= fixedPart(cut.limit));
    const below = cuts.filter((cut) => cut.limit < fixedPart(cut.limit));

    expect(limitsOf(reachable.filter((cut) => cut.length > cut.limit))).toEqual([]);
    // Below the fixed part nothing more can go: the body is that part, every line left out, and over the limit.
    expect(
      limitsOf(below.filter((cut) => cut.length !== fixedPart(cut.limit) || cut.left !== 42)),
    ).toEqual([]);
    expect(
      limitsOf(cuts.filter((cut) => cut.head?.join() !== [cut.limit, cut.left, 42].join())),
    ).toEqual([]);
    // Not vacuous: both sides of the fixed part were tried, and the reachable side met cuts of more than twenty sizes.
    expect(below.length).toBeGreaterThan(500);
    expect(new Set(reachable.map((cut) => cut.left)).size).toBeGreaterThan(20);
  });
});
