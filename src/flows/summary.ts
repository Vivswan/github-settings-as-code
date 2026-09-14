import type { SectionOutcome } from "../engine/orchestrate.js";
import type { RunOutcome } from "../engine/outcome.js";
import type { SectionSnapshotOutcome } from "../engine/snapshot.js";
import type { Io } from "../io.js";
import { markdownCell } from "../report/markdown.js";
import { countNoun } from "../text.js";
import type { PublicDetail, PublicTargetView } from "./redact.js";

type SummaryIo = Pick<Io, "summary">;

const STATUS_ICON: Record<
  SectionOutcome["status"] | RunOutcome | SectionSnapshotOutcome["status"],
  string
> = {
  applied: "white_check_mark",
  clean: "white_check_mark",
  snapshot: "white_check_mark",
  merged: "white_check_mark",
  drift: "warning",
  partial: "warning",
  skipped: "fast_forward",
  excluded: "fast_forward",
  unsupported: "fast_forward",
  failed: "x",
};

/** A section row as every mode renders it: the key, a status the icon map knows, its detail lines. */
interface SectionRow {
  key: string;
  status: keyof typeof STATUS_ICON;
  detail: string[];
}

function outcomeRows(outcomes: readonly SectionRow[]): string[] {
  const rows = ["| Section | Status | Detail |", "|---|---|---|"];
  for (const outcome of outcomes) {
    const detail = outcome.detail.map(markdownCell).join("<br>") || "-";
    rows.push(
      `| ${outcome.key} | :${STATUS_ICON[outcome.status]}: ${outcome.status} | ${detail} |`,
    );
  }
  return rows;
}

/** The moment a snapshot run read its repositories, as the summary and the run's notice state it. */
export function snapshotTakenLine(takenAt: string): string {
  return `Snapshot taken ${takenAt}.`;
}

/**
 * From the target's PUBLIC detail: statuses stay visible under redaction, the projection hides the cells. `facts`
 * are the run-level lines a mode adds ahead of the table (a snapshot's moment).
 */
export function writeSummary(
  io: SummaryIo,
  view: PublicDetail,
  mode: string,
  result: RunOutcome,
  facts: readonly string[] = [],
): void {
  const lines = [`## github-settings-as-code (${mode})`, ""];
  if (view.note !== undefined) {
    lines.push(`:${STATUS_ICON[result]}: ${result} - ${markdownCell(view.note)}`, "");
  }
  for (const fact of facts) {
    lines.push(fact, "");
  }
  io.summary([...lines, ...outcomeRows(view.outcomes)].join("\n"));
}

export function writeMergeSummary(
  io: SummaryIo,
  layers: readonly string[],
  mergedFile: string,
): void {
  const lines = [
    "## github-settings-as-code (merge)",
    "",
    "| Layer | Settings file |",
    "|---|---|",
    ...layers.map((path, index) => `| ${index + 1} | ${markdownCell(path)} |`),
    "",
    `Merged document written to ${markdownCell(mergedFile)}.`,
  ];
  io.summary(lines.join("\n"));
}

export function writeMultiSummary(io: SummaryIo, views: PublicTargetView[], mode: string): void {
  const lines = [
    `## github-settings-as-code (${mode}, ${countNoun(views.length, "repository", "repositories")})`,
    "",
    "| Repository | Source | Result |",
    "|---|---|---|",
  ];
  for (const view of views) {
    lines.push(
      `| ${markdownCell(view.display)} | ${view.source} | :${STATUS_ICON[view.result]}: ${view.result} |`,
    );
  }
  for (const view of views) {
    lines.push("", `### ${markdownCell(view.display)} (${view.result})`, "");
    if (view.note) {
      lines.push(markdownCell(view.note), "");
    }
    if (view.outcomes.length > 0) {
      lines.push(...outcomeRows(view.outcomes));
    }
  }
  io.summary(lines.join("\n"));
}

/** The snapshot-dir summary: the fleet rollup with each target's file and the run's moment, then one section table per target. */
export function writeSnapshotDirSummary(
  io: SummaryIo,
  views: readonly PublicTargetView[],
  snapshotDir: string,
  takenAt: string,
): void {
  const written = views.filter((view) => view.file !== undefined).length;
  const lines = [
    `## github-settings-as-code (snapshot, ${countNoun(views.length, "repository", "repositories")})`,
    "",
    written === 0
      ? `No snapshot was written under ${markdownCell(snapshotDir)}.`
      : written === views.length
        ? `Snapshots written under ${markdownCell(snapshotDir)}.`
        : `${written} of ${views.length} snapshots written under ${markdownCell(snapshotDir)}.`,
    "",
    snapshotTakenLine(takenAt),
    "",
    "| Repository | Source | Result | File |",
    "|---|---|---|---|",
  ];
  for (const view of views) {
    lines.push(
      `| ${markdownCell(view.display)} | ${view.source} | :${STATUS_ICON[view.result]}: ${view.result} | ${markdownCell(view.file ?? "-")} |`,
    );
  }
  for (const view of views) {
    lines.push("", `### ${markdownCell(view.display)} (${view.result})`, "");
    if (view.note) {
      lines.push(markdownCell(view.note), "");
    }
    if (view.outcomes.length > 0) {
      lines.push(...outcomeRows(view.outcomes));
    }
  }
  io.summary(lines.join("\n"));
}
