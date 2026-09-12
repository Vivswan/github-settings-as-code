/**
 * One markdown document per redacted target, rendered identically for both channels. Pure, and structurally typed on
 * purpose, so it depends on no action-layer types.
 */

import type { AnnotationLevel } from "../io.js";
import { markdownCell } from "./markdown.js";

interface TranscriptLine {
  level?: AnnotationLevel;
  line: string;
}

interface OutcomeRow {
  key: string;
  status: string;
  detail: string[];
}

export interface ReportInput {
  /** The target's owner/name slug, unredacted: this document is private. */
  target: string;
  adminRepo: string;
  runUrl: string;
  mode: string;
  result: string;
  timestamp: string;
  outcomes: OutcomeRow[];
  transcript: TranscriptLine[];
}

/** A fence longer than any backtick run inside the content, so a transcript line can never terminate the block early. */
function fenceFor(content: string): string {
  const longest = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longest + 1));
}

function transcriptLine(entry: TranscriptLine): string {
  return entry.level === undefined ? entry.line : `[${entry.level}] ${entry.line}`;
}

/** The report's first line. src/report/issue-report.ts reads it back as the proof that an issue body is one of these reports. */
export const REPORT_HEADING = "# settings-as-code private report:";

export function composeReport(input: ReportInput): string {
  const lines: string[] = [
    `${REPORT_HEADING} ${input.target}`,
    "",
    "Full, unredacted report for this target. The public run redacts it; this document is its private mirror.",
    "",
    "| | |",
    "|---|---|",
    `| Target | ${markdownCell(input.target)} |`,
    `| Admin repository | ${markdownCell(input.adminRepo)} |`,
    `| Run | ${markdownCell(input.runUrl)} |`,
    `| Mode | ${markdownCell(input.mode)} |`,
    `| Result | ${markdownCell(input.result)} |`,
    `| Generated | ${markdownCell(input.timestamp)} |`,
    "",
    "## Sections",
    "",
  ];
  if (input.outcomes.length === 0) {
    lines.push("No sections ran for this target.");
  } else {
    lines.push("| Section | Status | Detail |", "|---|---|---|");
    for (const outcome of input.outcomes) {
      const detail = outcome.detail.map(markdownCell).join("<br>");
      lines.push(`| ${markdownCell(outcome.key)} | ${markdownCell(outcome.status)} | ${detail} |`);
    }
  }
  lines.push("", "## Transcript", "");
  if (input.transcript.length === 0) {
    lines.push("No output was captured for this target.");
  } else {
    const body = input.transcript.map(transcriptLine).join("\n");
    const fence = fenceFor(body);
    lines.push(fence, body, fence);
  }
  lines.push("");
  return lines.join("\n");
}
