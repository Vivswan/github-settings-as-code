/**
 * One markdown document per redacted target, rendered identically for both channels, except that a channel whose
 * document has a length limit gets it cut to fit. Pure, and structurally typed on purpose, so it depends on no
 * action-layer types.
 */

import type { AnnotationLevel } from "../io.js";
import { markdownCell, renderTable } from "./markdown.js";

interface TranscriptLine {
  level?: AnnotationLevel;
  line: string;
}

interface OutcomeRow {
  key: string;
  status: string;
  detail: string[];
}

/** What one report renders; `target` is the owner/name slug, unredacted: this document is private. */
export interface ReportInput {
  target: string;
  adminRepo: string;
  runUrl: string;
  mode: string;
  result: string;
  timestamp: string;
  outcomes: OutcomeRow[];
  transcript: TranscriptLine[];
}

/** Joins the lines of one detail cell: a table row is a single line, so the cell breaks its lines in HTML. */
const BREAK = "<br>";

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

/** How many lines of each list a document carries: one count per section's detail, in outcome order, and the transcript's. */
interface Kept {
  detail: number[];
  transcript: number;
}

/** Stands where a list was cut, in a detail cell and under the transcript alike. */
function leftOutMark(count: number): string {
  return `(lines left out: ${count})`;
}

/** The document carrying `kept` lines of each list. A list cut short ends in its mark, and any cut is announced under the heading. */
function render(input: ReportInput, kept: Kept, limit: number): string {
  const total = input.outcomes.reduce((sum, o) => sum + o.detail.length, input.transcript.length);
  const carried = kept.detail.reduce((sum, count) => sum + count, kept.transcript);
  const lines: string[] = [
    `${REPORT_HEADING} ${input.target}`,
    "",
    "Full, unredacted report for this target. The public run redacts it; this document is its private mirror.",
    "",
  ];
  if (carried < total) {
    lines.push(
      `**Cut to fit ${limit} characters.** Lines left out: ${total - carried} of ${total}; each cut is marked where it was made.`,
      "",
    );
  }
  lines.push(
    renderTable("| | |\n|---|---|", [
      ["Target", markdownCell(input.target)],
      ["Admin repository", markdownCell(input.adminRepo)],
      ["Run", markdownCell(input.runUrl)],
      ["Mode", markdownCell(input.mode)],
      ["Result", markdownCell(input.result)],
      ["Generated", markdownCell(input.timestamp)],
    ]),
    "",
    "## Sections",
    "",
  );
  if (input.outcomes.length === 0) {
    lines.push("No sections ran for this target.");
  } else {
    lines.push(
      renderTable(
        "| Section | Status | Detail |\n|---|---|---|",
        input.outcomes.map((outcome, row) => {
          const shown = outcome.detail.slice(0, kept.detail[row]).map(markdownCell);
          const cut = outcome.detail.length - shown.length;
          return [
            markdownCell(outcome.key),
            markdownCell(outcome.status),
            (cut > 0 ? [...shown, leftOutMark(cut)] : shown).join(BREAK),
          ];
        }),
      ),
    );
  }
  lines.push("", "## Transcript", "");
  if (input.transcript.length === 0) {
    lines.push("No output was captured for this target.");
  } else {
    const shown = input.transcript.slice(0, kept.transcript).map(transcriptLine);
    if (shown.length > 0) {
      const body = shown.join("\n");
      const fence = fenceFor(body);
      lines.push(fence, body, fence);
    }
    if (shown.length < input.transcript.length) {
      lines.push(
        ...(shown.length > 0 ? [""] : []),
        leftOutMark(input.transcript.length - shown.length),
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The lines that fit under `limit`, spent in the order a reader loses least: each section's detail first, one line per
 * section in turn so a long section never starves a short one, then the transcript from its start, which repeats the
 * detail. A list ends at its first line that does not fit. Every line is paid for against the document that carries
 * none, whose marks are the longest a cut renders, so the result is over the limit only when that document is.
 */
function fit(input: ReportInput, limit: number): Kept {
  const kept: Kept = { detail: input.outcomes.map(() => 0), transcript: 0 };
  // What a first transcript line adds beyond itself: the two fences, their line ends, and the blank line above the mark.
  const fences = 2 * fenceFor(input.transcript.map(transcriptLine).join("\n")).length + 3;
  let room = limit - render(input, kept, limit).length - fences;
  const take = (cost: number): boolean => {
    if (cost > room) {
      return false;
    }
    room -= cost;
    return true;
  };
  const open = new Set(input.outcomes.keys());
  for (let depth = 0; open.size > 0; depth++) {
    for (const row of open) {
      const line = input.outcomes[row]?.detail[depth];
      if (line !== undefined && take(markdownCell(line).length + BREAK.length)) {
        kept.detail[row] = depth + 1;
      } else {
        open.delete(row);
      }
    }
  }
  for (const entry of input.transcript) {
    if (!take(transcriptLine(entry).length + 1)) {
      break;
    }
    kept.transcript += 1;
  }
  return kept;
}

/** `limit` is the most characters the document may hold: over it, lines are left out and the document counts them. */
export function composeReport(input: ReportInput, limit = Number.POSITIVE_INFINITY): string {
  const all: Kept = {
    detail: input.outcomes.map((outcome) => outcome.detail.length),
    transcript: input.transcript.length,
  };
  const whole = render(input, all, limit);
  return whole.length <= limit ? whole : render(input, fit(input, limit), limit);
}
