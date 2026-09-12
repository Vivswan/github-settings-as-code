import type { RepoResult, SectionOutcome } from "../engine/orchestrate.js";
import type { Io } from "../io.js";
import { markdownCell } from "../report/markdown.js";
import type { PublicDetail, PublicTargetView } from "./redact.js";

type SummaryIo = Pick<Io, "summary">;

const STATUS_ICON: Record<SectionOutcome["status"] | RepoResult, string> = {
  applied: "white_check_mark",
  clean: "white_check_mark",
  drift: "warning",
  partial: "warning",
  skipped: "fast_forward",
  excluded: "fast_forward",
  failed: "x",
};

function outcomeRows(outcomes: PublicDetail["outcomes"]): string[] {
  const rows = ["| Section | Status | Detail |", "|---|---|---|"];
  for (const outcome of outcomes) {
    const detail = outcome.detail.map(markdownCell).join("<br>") || "-";
    rows.push(
      `| ${outcome.key} | :${STATUS_ICON[outcome.status]}: ${outcome.status} | ${detail} |`,
    );
  }
  return rows;
}

/** From the target's PUBLIC detail: statuses stay visible under redaction, the projection hides the cells. */
export function writeSummary(
  io: SummaryIo,
  view: PublicDetail,
  mode: string,
  result: RepoResult,
): void {
  const lines = [`## github-settings-as-code (${mode})`, ""];
  if (view.note !== undefined) {
    lines.push(`:${STATUS_ICON[result]}: ${result} - ${markdownCell(view.note)}`, "");
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
    `## github-settings-as-code (${mode}, ${views.length} repositories)`,
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
