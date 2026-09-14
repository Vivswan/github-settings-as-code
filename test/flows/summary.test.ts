import { describe, expect, test } from "bun:test";
import type { PublicTargetView } from "../../src/flows/redact.js";
import { writeMultiSummary, writeSnapshotDirSummary } from "../../src/flows/summary.js";
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
