import type { SectionOutcome } from "../engine/orchestrate.js";
import type { RunOutcome } from "../engine/outcome.js";
import type { SectionSnapshotOutcome } from "../engine/snapshot.js";
import type { Io } from "../io.js";
import { markdownCell, renderTable } from "../report/markdown.js";
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
  rendered: "white_check_mark",
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

function statusCell(status: keyof typeof STATUS_ICON): string {
  return `:${STATUS_ICON[status]}: ${status}`;
}

// Every free-text cell passes through markdownCell(): the summary never refuses a value, so a pipe in a
// repository name or a detail line is escaped, and the detail lines meet inside one cell.
function outcomeTable(outcomes: readonly SectionRow[]): string {
  return renderTable(
    "| Section | Status | Detail |\n|---|---|---|",
    outcomes.map((outcome) => [
      outcome.key,
      statusCell(outcome.status),
      outcome.detail.map(markdownCell).join("<br>") || "-",
    ]),
  );
}

/** The fleet rollup's cells for one target: its name, its source, its result. */
function targetCells(view: PublicTargetView): [string, string, string] {
  return [markdownCell(view.display), view.source, statusCell(view.result)];
}

/** Each target's heading, its note, and its section table when it has sections. */
function targetDetails(views: readonly PublicTargetView[]): string[] {
  return views.flatMap((view) => [
    "",
    `### ${markdownCell(view.display)} (${view.result})`,
    "",
    ...(view.note ? [markdownCell(view.note), ""] : []),
    ...(view.outcomes.length > 0 ? [outcomeTable(view.outcomes)] : []),
  ]);
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
    lines.push(`${statusCell(result)} - ${markdownCell(view.note)}`, "");
  }
  for (const fact of facts) {
    lines.push(fact, "");
  }
  io.summary([...lines, outcomeTable(view.outcomes)].join("\n"));
}

export function writeRenderSummary(
  io: SummaryIo,
  layers: readonly string[],
  renderedFile: string,
): void {
  const lines = [
    "## github-settings-as-code (render)",
    "",
    renderTable(
      "| Layer | Settings file |\n|---|---|",
      layers.map((path, index) => [`${index + 1}`, markdownCell(path)]),
    ),
    "",
    `Rendered document written to ${markdownCell(renderedFile)}.`,
  ];
  io.summary(lines.join("\n"));
}

export function writeMultiSummary(io: SummaryIo, views: PublicTargetView[], mode: string): void {
  const lines = [
    `## github-settings-as-code (${mode}, ${countNoun(views.length, "repository", "repositories")})`,
    "",
    renderTable("| Repository | Source | Result |\n|---|---|---|", views.map(targetCells)),
    ...targetDetails(views),
  ];
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
    renderTable(
      "| Repository | Source | Result | File |\n|---|---|---|---|",
      views.map((view) => [...targetCells(view), markdownCell(view.file ?? "-")]),
    ),
    ...targetDetails(views),
  ];
  io.summary(lines.join("\n"));
}
