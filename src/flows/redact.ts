/**
 * GitHub Actions has no log-level access control: run logs, summaries, and outputs inherit the admin repository's
 * visibility, so a public admin repo would leak a private target's slug and live settings. Redaction is the choke
 * point: the plan decides which targets hide, the channel routes their lines into a transcript and seals the end state,
 * and the projections open the seal into the public view.
 */

import type { Target } from "../discovery/targets.js";
import type { RepoRunResult } from "../engine/orchestrate.js";
import type { RepoVisibility } from "../github/repo-visibility.js";
import { type CollectedLine, type Io, prefixedIo } from "../io.js";
import { isPrivate, markPrivate, type Private } from "../private.js";
import { revealPrivate } from "../private-open.js";
import type { RedactedDetail, TargetDetail } from "../report/delivery.js";
import type { SectionKey } from "../schema.js";

export const PRIVATE_REPOS_POLICIES = ["redact", "show"] as const;

export type PrivateReposPolicy = (typeof PRIVATE_REPOS_POLICIES)[number];

export const REDACTED_NOTE =
  "details hidden: the repository is private or internal. Set private-repos: show to reveal them, or run the action inside that repository";

export const REDACTED_DETAIL = "hidden (private repository)";

/**
 * For a redacted target whose visibility could not be PROVEN private or internal, so the report was withheld (delivery
 * fails closed the opposite way from redaction). Shared verbatim by both run flows: the cause and the fix are slug-free.
 */
export const WITHHELD_REPORT_NOTICE =
  "visibility could not be verified (the repository-metadata probe failed or was inconclusive " +
  "- typically the token cannot read the target repository), so the private report was " +
  "withheld rather than risk delivering it to a public repository. Grant the token metadata " +
  "read access and re-run; a transient API failure also leaves visibility unverified";

/** One multi-repo target's end state: safe closed values plus the detail the public view projects from. */
export interface TargetOutcome {
  source: Target["source"];
  result: RepoRunResult["result"];
  /** The public label: the slug, or its "private repository #N" placeholder. */
  display: string;
  detail: TargetDetail | Private<RedactedDetail>;
}

/** A leak-free section outcome: key and status survive, detail is hidden. */
type RedactedOutcome = {
  key: SectionKey;
  status: RepoRunResult["outcomes"][number]["status"];
  detail: string[];
};

/**
 * The key and status (closed enums, provably leak-free) survive; every detail value becomes the placeholder plus, on
 * failed/skipped rows, the HTTP code.
 */
function redactOutcomes(outcomes: RepoRunResult["outcomes"]): RedactedOutcome[] {
  return outcomes.map((o) => {
    const withCode =
      o.httpStatus !== undefined ? `${REDACTED_DETAIL}, HTTP ${o.httpStatus}` : REDACTED_DETAIL;
    return { key: o.key, status: o.status, detail: [withCode] };
  });
}

/** The public rendering of one target's detail: the section rows and the note under its heading. */
export interface PublicDetail {
  outcomes: RedactedOutcome[];
  note?: string;
}

export function publicDetail(detail: TargetOutcome["detail"]): PublicDetail {
  if (isPrivate(detail)) {
    return { outcomes: redactOutcomes(revealPrivate(detail).outcomes), note: REDACTED_NOTE };
  }
  return {
    outcomes: detail.outcomes.map((o) => ({ key: o.key, status: o.status, detail: o.detail })),
    note: detail.note,
  };
}

export interface PublicTargetView extends PublicDetail {
  display: string;
  source: Target["source"];
  result: RepoRunResult["result"];
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
  result: RepoRunResult["result"],
  detail: Private<RedactedDetail>,
): void {
  const { outcomes } = revealPrivate(detail);
  if (result === "failed") {
    const failed = outcomes
      .filter((o) => o.status === "failed")
      .map((o) => (o.httpStatus !== undefined ? `${o.key} (${o.httpStatus})` : o.key));
    const sections = failed.length > 0 ? ` - ${failed.join(", ")}` : "";
    io.annotate("error", `${display}: failed${sections}. ${REDACTED_NOTE}`);
    return;
  }
  if (result === "drift") {
    const drifted = outcomes.filter((o) => o.status === "drift").map((o) => o.key);
    const sections = drifted.length > 0 ? ` - ${drifted.join(", ")}` : "";
    io.annotate("warning", `${display}: drift${sections}. ${REDACTED_NOTE}`);
    return;
  }
  if (result === "skipped") {
    io.annotate("notice", `${display}: skipped. ${REDACTED_NOTE}`);
  }
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
    placeholders.set(key, `private repository #${n}`);
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
 * surfaces are written from the public view), only the mask registry passes through.
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
  close(outcomes: RepoRunResult["outcomes"], note?: string): TargetOutcome["detail"];
}

export function publicChannel(io: Io, slug: string, attributed: boolean): TargetChannel {
  return {
    display: slug,
    io: prefixedIo(io, attributed ? `${slug}: ` : ""),
    unprefixed: io,
    close: (outcomes, note) => ({ slug, outcomes, note }),
  };
}

export function redactedChannel(io: Io, slug: string, display: string): TargetChannel {
  const capture = capturingIo(io);
  return {
    display,
    io: capture.io,
    unprefixed: capture.io,
    close: (outcomes, note) => markPrivate({ slug, outcomes, note, transcript: capture.drain() }),
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
