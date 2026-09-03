/**
 * Step-summary rendering: the per-section table (single-repo) and the
 * per-repository overview plus per-target tables (multi-repo). Each writer
 * renders one block and hands it to the Io port's summary channel.
 */

import type { RepoResult, SectionOutcome } from "../engine/orchestrate.js";
import type { Io } from "../io.js";
import { markdownCell } from "../report/markdown.js";
import { type PublicTargetView, REDACTED_NOTE, redactOutcomes } from "./redact.js";

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

/** The fields the section table renders; both SectionOutcome and the public view meet it. */
type OutcomeRow = Pick<SectionOutcome, "key" | "status" | "detail">;

function outcomeRows(outcomes: OutcomeRow[]): string[] {
  const rows = ["| Section | Status | Detail |", "|---|---|---|"];
  for (const outcome of outcomes) {
    const detail = outcome.detail.map(markdownCell).join("<br>") || "-";
    rows.push(
      `| ${outcome.key} | :${STATUS_ICON[outcome.status]}: ${outcome.status} | ${detail} |`,
    );
  }
  return rows;
}

export function writeSummary(io: SummaryIo, outcomes: SectionOutcome[], mode: string): void {
  io.summary([`## github-settings-as-code (${mode})`, "", ...outcomeRows(outcomes)].join("\n"));
}

/**
 * The single-repo summary for a redacted cross-repo target. The redaction
 * policy keeps per-section STATUSES visible everywhere, so this renders the
 * same section table the multi path renders - statuses in the clear, detail
 * cells hidden - via the shared redactOutcomes() projection, not a second
 * rendering. Used when the single-repo `repository` input names a different,
 * non-public repo.
 */
export function writeRedactedSummary(
  io: SummaryIo,
  outcomes: SectionOutcome[],
  mode: string,
  result: RepoResult,
): void {
  io.summary(
    [
      `## github-settings-as-code (${mode})`,
      "",
      `:${STATUS_ICON[result]}: ${result} - ${REDACTED_NOTE}`,
      "",
      ...outcomeRows(redactOutcomes(outcomes)),
    ].join("\n"),
  );
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
