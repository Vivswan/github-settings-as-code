import { describe, expect, test } from "bun:test";
import type { PublicDetail, PublicTargetView } from "../../src/flows/redact.js";
import {
  writeMultiSummary,
  writeRenderSummary,
  writeSnapshotDirSummary,
  writeSummary,
} from "../../src/flows/summary.js";
import { captureIo } from "../io/capture.js";

function fleet(size: number): PublicTargetView[] {
  return Array.from({ length: size }, (_, i) => ({
    display: `o/r${i + 1}`,
    source: "remote" as const,
    result: "applied" as const,
    outcomes: [],
  }));
}

const HEADINGS: Array<[string, (views: PublicTargetView[]) => string]> = [
  [
    "writeMultiSummary",
    (views) => {
      const { io, events } = captureIo();
      writeMultiSummary(io, views, "apply");
      return events[0] ?? "";
    },
  ],
  [
    "writeSnapshotDirSummary",
    (views) => {
      const { io, events } = captureIo();
      writeSnapshotDirSummary(io, views, "snapshots", "2026-09-13T00:00:00.000Z");
      return events[0] ?? "";
    },
  ],
];

describe("the fleet heading counts its repositories", () => {
  test.each([
    [1, "1 repository"],
    [2, "2 repositories"],
  ])("a fleet of %i heads with %s", (size, phrase) => {
    for (const [name, heading] of HEADINGS) {
      expect([name, heading(fleet(size))]).toEqual([
        name,
        expect.stringMatching(
          new RegExp(`^summary: ## github-settings-as-code \\(\\w+, ${phrase}\\)$`),
        ),
      ]);
    }
  });
});

// The step summary is what GitHub renders, so its bytes are pinned whole: a cell that stops being escaped, a
// separator row that moves, or a detail line that leaves its cell shows here and nowhere else. The specimens
// put a pipe in every free-text slot, a backslash in the names, the note, the paths, and a detail line, a line
// break in a detail line, and leave one detail list empty.
describe("the step summary bytes", () => {
  const outcomes = [
    { key: "labels", status: "applied", detail: ["3 upserts", "a | b", "c\\d", "e\nf"] },
    { key: "rulesets", status: "skipped", detail: [] },
  ] satisfies PublicDetail["outcomes"];
  const views: PublicTargetView[] = [
    {
      display: "o/r|1\\2",
      source: "remote",
      result: "applied",
      outcomes,
      file: "snapshots/o/r|1.yml",
    },
    {
      display: "o/r2",
      source: "central",
      result: "failed",
      outcomes: [],
      note: "token | lacks \\ scope",
    },
  ];
  const whole = (write: (io: { summary: (markdown: string) => void }) => void): string => {
    const summaries: string[] = [];
    write({ summary: (markdown) => summaries.push(markdown) });
    return summaries.join("\n=====\n");
  };
  const sectionTable = [
    "| Section | Status | Detail |",
    "|---|---|---|",
    "| labels | :white_check_mark: applied | 3 upserts<br>a \\| b<br>c\\\\d<br>e f |",
    "| rulesets | :fast_forward: skipped | - |",
  ].join("\n");
  const perTarget = [
    "",
    "### o/r\\|1\\\\2 (applied)",
    "",
    sectionTable,
    "",
    "### o/r2 (failed)",
    "",
    "token \\| lacks \\\\ scope",
    "",
  ].join("\n");

  test.each<
    [name: string, write: (io: { summary: (markdown: string) => void }) => void, expected: string]
  >([
    [
      "writeSummary",
      (io) =>
        writeSummary(io, { outcomes, note: "redacted | view" }, "check", "drift", ["Fact | one."]),
      [
        "## github-settings-as-code (check)",
        "",
        ":warning: drift - redacted \\| view",
        "",
        "Fact | one.",
        "",
        sectionTable,
      ].join("\n"),
    ],
    [
      "writeRenderSummary",
      (io) => writeRenderSummary(io, ["layers/a|b.yml", "layers\\c.yml"], "out/settings|.yml"),
      [
        "## github-settings-as-code (render)",
        "",
        "| Layer | Settings file |",
        "|---|---|",
        "| 1 | layers/a\\|b.yml |",
        "| 2 | layers\\\\c.yml |",
        "",
        "Rendered document written to out/settings\\|.yml.",
      ].join("\n"),
    ],
    [
      "writeMultiSummary",
      (io) => writeMultiSummary(io, views, "apply"),
      [
        "## github-settings-as-code (apply, 2 repositories)",
        "",
        "| Repository | Source | Result |",
        "|---|---|---|",
        "| o/r\\|1\\\\2 | remote | :white_check_mark: applied |",
        "| o/r2 | central | :x: failed |",
        perTarget,
      ].join("\n"),
    ],
    [
      "writeSnapshotDirSummary",
      (io) => writeSnapshotDirSummary(io, views, "snap|dir", "2026-09-13T00:00:00.000Z"),
      [
        "## github-settings-as-code (snapshot, 2 repositories)",
        "",
        "1 of 2 snapshots written under snap\\|dir.",
        "",
        "Snapshot taken 2026-09-13T00:00:00.000Z.",
        "",
        "| Repository | Source | Result | File |",
        "|---|---|---|---|",
        "| o/r\\|1\\\\2 | remote | :white_check_mark: applied | snapshots/o/r\\|1.yml |",
        "| o/r2 | central | :x: failed | - |",
        perTarget,
      ].join("\n"),
    ],
  ])("%s writes the pinned markdown over the hostile specimens", (_name, write, expected) => {
    expect(whole(write)).toBe(expected);
  });
});
