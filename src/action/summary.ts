/**
 * Step-summary rendering: the per-section table (single-repo) and the
 * per-repository overview plus per-target tables (multi-repo). Each writer
 * renders one block and hands it to the Io port's summary channel.
 */

import type { RepoResult, SectionOutcome } from "../engine/orchestrate.js";
import type { Io } from "../io.js";
import { markdownCell } from "../report/markdown.js";
import type { PublicDetail, PublicTargetView } from "./redact.js";

type SummaryIo = Pick<Io, "summary">;

// Typed over every status both summary writers can meet, so a new status
// value fails compilation here instead of rendering ":undefined:".
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

/**
 * The single-repo summary from the target's PUBLIC detail: the section table
 * (statuses stay visible under redaction; the projection hides the cells),
 * headed by the result and note when the projection attached one.
 */
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
