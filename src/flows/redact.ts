/**
 * GitHub Actions has no log-level access control: run logs, summaries, and outputs inherit the admin repository's
 * visibility, so a public admin repo would leak a private target's slug and live settings. Redaction is the choke
 * point: the plan decides which targets hide, the channel routes their lines into a transcript and seals the end state,
 * and the projections open the seal into the public view. Every mode's target (single, multi, snapshot) closes through
 * the same channel, so no flow projects a private target on its own.
 */

import type { Target } from "../discovery/targets.js";
import type { RunOutcome } from "../engine/outcome.js";
import type { RepoVisibility } from "../github/repo-visibility.js";
import { type CollectedLine, type Io, prefixedIo } from "../io.js";
import { isPrivate, markPrivate, type Private } from "../private.js";
import { revealPrivate } from "../private-open.js";
import type { ClosedOutcome, RedactedDetail, TargetDetail } from "../report/delivery.js";

export const PRIVATE_REPOS_POLICIES = ["redact", "show"] as const;

export type PrivateReposPolicy = (typeof PRIVATE_REPOS_POLICIES)[number];

export const REDACTED_NOTE =
  "details hidden: the repository is private or internal. Set private-repos: show to reveal them, or run the action inside that repository";

export const REDACTED_DETAIL = "hidden (private repository)";

/** The one public label a hidden target gets, in every mode: numbered in target order, so a run over one target is #1. */
export function privatePlaceholder(n: number): string {
  return `private repository #${n}`;
}

/**
 * For a redacted target whose visibility could not be PROVEN private or internal, so the report was withheld (delivery
 * fails closed the opposite way from redaction). Shared verbatim by both run flows: the cause and the fix are slug-free.
 */
export const WITHHELD_REPORT_NOTICE =
  "visibility could not be verified (the repository-metadata probe failed or was inconclusive " +
  "- typically the token cannot read the target repository), so the private report was " +
  "withheld rather than risk delivering it to a public repository. Grant the token metadata " +
  "read access and re-run; a transient API failure also leaves visibility unverified";

/** One target's end state: safe closed values plus the detail the public view projects from. */
export interface TargetOutcome {
  source: Target["source"];
  result: RunOutcome;
  /** The public label: the slug, or its "private repository #N" placeholder. */
  display: string;
  detail: TargetDetail | Private<RedactedDetail>;
}

/** A leak-free section outcome: key and status survive, detail is hidden. */
type RedactedOutcome = {
  key: ClosedOutcome["key"];
  status: ClosedOutcome["status"];
  detail: string[];
};

/**
 * The key and status (closed enums, provably leak-free) survive; every detail value becomes the placeholder plus, on
 * failed/skipped rows, the HTTP code.
 */
function redactOutcomes(outcomes: ClosedOutcome[]): RedactedOutcome[] {
  return outcomes.map((o) => {
    const withCode =
      o.httpStatus !== undefined ? `${REDACTED_DETAIL}, HTTP ${o.httpStatus}` : REDACTED_DETAIL;
    return { key: o.key, status: o.status, detail: [withCode] };
  });
}

/** The public rendering of one target's detail: the section rows, the note under its heading, and the file it wrote. */
export interface PublicDetail {
  outcomes: RedactedOutcome[];
  note?: string;
  /** Where a snapshot target's file went, as the public view may show it. */
  file?: string;
}

export function publicDetail(detail: TargetOutcome["detail"]): PublicDetail {
  if (isPrivate(detail)) {
    const { outcomes, file } = revealPrivate(detail);
    return {
      outcomes: redactOutcomes(outcomes),
      note: REDACTED_NOTE,
      ...(file === undefined ? {} : { file: REDACTED_DETAIL }),
    };
  }
  return {
    outcomes: detail.outcomes.map((o) => ({ key: o.key, status: o.status, detail: o.detail })),
    note: detail.note,
    ...(detail.file === undefined ? {} : { file: detail.file }),
  };
}

export interface PublicTargetView extends PublicDetail {
  display: string;
  source: Target["source"];
  result: RunOutcome;
}

export function toPublicView(target: TargetOutcome): PublicTargetView {
  return {
    display: target.display,
    source: target.source,
    result: target.result,
    ...publicDetail(target.detail),
  };
}

export function isPrivateVisibility(visibility: RepoVisibility): boolean {
  return visibility === "private" || visibility === "internal";
}

/**
 * The single generic annotation a redacted target gets, closed values only: failed and drifted section keys, HTTP
 * codes; a healthy run says nothing.
 */
export function emitRedactedResult(
  io: Io,
  display: string,
  result: RunOutcome,
  detail: Private<RedactedDetail>,
): void {
  const { outcomes } = revealPrivate(detail);
  // The keys in one status, each with its safe HTTP code when the row carries one (a denial's, never a body).
  const keysWith = (status: ClosedOutcome["status"]): string => {
    const keys = outcomes
      .filter((o) => o.status === status)
      .map((o) => (o.httpStatus !== undefined ? `${o.key} (${o.httpStatus})` : o.key));
    return keys.length > 0 ? ` - ${keys.join(", ")}` : "";
  };
  switch (result) {
    case "failed":
      io.annotate("error", `${display}: failed${keysWith("failed")}. ${REDACTED_NOTE}`);
      return;
    case "drift":
      io.annotate("warning", `${display}: drift${keysWith("drift")}. ${REDACTED_NOTE}`);
      return;
    case "partial":
      io.annotate("warning", `${display}: partial${keysWith("skipped")}. ${REDACTED_NOTE}`);
      return;
    case "skipped":
      io.annotate("notice", `${display}: skipped. ${REDACTED_NOTE}`);
      return;
    case "applied":
    case "clean":
    case "snapshot":
    case "rendered":
      // A healthy result prints nothing: the summary row already says so in closed values.
      return;
    default:
      unreachable(result);
  }
}

function unreachable(result: never): never {
  throw new Error(`BUG: emitRedactedResult has no arm for the run result ${String(result)}`);
}

export interface RedactionPlan {
  isRedacted(slug: string): boolean;
  display(slug: string): string;
  /** Every slug that must be masked: redacted targets plus discovery-filtered privates. */
  maskedSlugs: string[];
}

const SHOW_EVERYTHING: RedactionPlan = {
  isRedacted: () => false,
  display: (slug) => slug,
  maskedSlugs: [],
};

export function planRedaction(
  policy: PrivateReposPolicy,
  orderedTargetSlugs: string[],
  extraPrivateSlugs: Private<string>[],
  isPrivateSlug: (slug: string) => boolean,
  selfSlug: string,
): RedactionPlan {
  if (policy === "show") {
    return SHOW_EVERYTHING;
  }
  const self = selfSlug.toLowerCase();
  const placeholders = new Map<string, string>();
  const masked = new Map<string, string>();

  let n = 0;
  for (const slug of orderedTargetSlugs) {
    const key = slug.toLowerCase();
    if (key === self || !isPrivateSlug(slug) || placeholders.has(key)) {
      continue;
    }
    n += 1;
    placeholders.set(key, privatePlaceholder(n));
    masked.set(key, slug);
  }
  for (const sealed of extraPrivateSlugs) {
    const slug = revealPrivate(sealed);
    const key = slug.toLowerCase();
    if (key === self || masked.has(key)) {
      continue;
    }
    masked.set(key, slug);
  }

  return {
    isRedacted: (slug) => placeholders.has(slug.toLowerCase()),
    display: (slug) => placeholders.get(slug.toLowerCase()) ?? slug,
    maskedSlugs: [...masked.values()],
  };
}

/**
 * Lets nothing textual out: annotate/log are recorded for the private report, debug/summary/output are dropped (those
 * surfaces are written from the public view), only the mask registry passes through. The lines are recorded UNMASKED so
 * the report can name the private slug; a masked secret never reaches them, because a resolved plaintext is consumed
 * only inside payload thunks and sealing, and GitHubApi withholds every error body and transport message of a
 * secret-carrying request (the e2e runner's checkReportLeaks sweeps each delivered report for the run's secrets).
 */
export function capturingIo(io: Io): { io: Io; drain(): CollectedLine[] } {
  const captured: CollectedLine[] = [];
  return {
    io: {
      annotate: (level, message) => captured.push({ level, line: message }),
      log: (line) => captured.push({ line }),
      debug: () => {},
      summary: () => {},
      output: () => {},
      mask: io.mask,
      masked: io.masked,
    },
    drain: () => [...captured],
  };
}

/**
 * Opened ONCE from the redaction decision: in the clear it emits publicly and closes open, redacted it captures every
 * annotation and log line and closes sealed. Processing code holds only this.
 */
export interface TargetChannel {
  /** The public label: the slug, or its placeholder. */
  display: string;
  /** Sink for the target's own lines, attributed to it (prefixed in the clear). */
  io: Io;
  /** Sink for lines that already name their source (validation warnings): unprefixed, or the same capture. */
  unprefixed: Io;
  /** Seals or opens the target's end state: everything in its detail but the slug, which the channel holds. */
  close(end: Omit<TargetDetail, "slug">): TargetOutcome["detail"];
}

export function publicChannel(io: Io, slug: string, attributed: boolean): TargetChannel {
  return {
    display: slug,
    io: prefixedIo(io, attributed ? `${slug}: ` : ""),
    unprefixed: io,
    close: ({ outcomes, note, file }) => ({ slug, outcomes, note, file }),
  };
}

export function redactedChannel(io: Io, slug: string, display: string): TargetChannel {
  const capture = capturingIo(io);
  return {
    display,
    io: capture.io,
    unprefixed: capture.io,
    close: ({ outcomes, note, file }) =>
      markPrivate({ slug, outcomes, note, file, transcript: capture.drain() }),
  };
}

/**
 * A crash (a preflight write attempt naming its path, an engine bug) is the target's failure, spoken only through the
 * channel's sink, so a redacted repository's text never reaches a top-level handler.
 */
export async function attempt<T>(
  channel: TargetChannel,
  work: () => Promise<T>,
  failed: (message: string) => T,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    channel.io.annotate("error", message);
    return failed(message);
  }
}

export function openTargetChannel(plan: RedactionPlan, io: Io, slug: string): TargetChannel {
  return plan.isRedacted(slug)
    ? redactedChannel(io, slug, plan.display(slug))
    : publicChannel(io, slug, true);
}
