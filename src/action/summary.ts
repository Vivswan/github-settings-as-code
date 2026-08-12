/**
 * Step-summary rendering: the per-section table (single-repo) and the
 * per-repository overview plus per-target tables (multi-repo).
 */

import { appendFileSync } from "node:fs";
import type { RepoResult, SectionOutcome } from "../engine/orchestrate.js";
import { markdownCell } from "../report/markdown.js";
import { type PublicTargetView, REDACTED_NOTE, redactOutcomes } from "./redact.js";

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

/**
 * The shared write frame: resolve GITHUB_STEP_SUMMARY, skip when it is unset
 * (local/test runs), and append the built lines. `build` runs only when there
 * is a file to write, so a caller never assembles a summary that is discarded.
 */
function writeSummaryFile(build: () => string[]): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  appendFileSync(file, `${build().join("\n")}\n`);
}

export function writeSummary(outcomes: SectionOutcome[], mode: string): void {
  writeSummaryFile(() => [`## github-settings-as-code (${mode})`, "", ...outcomeRows(outcomes)]);
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
  outcomes: SectionOutcome[],
  mode: string,
  result: RepoResult,
): void {
  writeSummaryFile(() => [
    `## github-settings-as-code (${mode})`,
    "",
    `:${STATUS_ICON[result]}: ${result} - ${REDACTED_NOTE}`,
    "",
    ...outcomeRows(redactOutcomes(outcomes)),
  ]);
}

export function writeMultiSummary(views: PublicTargetView[], mode: string): void {
  writeSummaryFile(() => {
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
    return lines;
  });
}
