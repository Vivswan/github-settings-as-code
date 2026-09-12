/**
 * The private-report channel of one run: the full unredacted report per redacted
 * target, delivered to the target's report issue or the age-encrypted artifact,
 * plus the marker-label injection that keeps an apply from deleting the issue's label.
 */

import type { RepoRef } from "../discovery/targets.js";
import type { RepoResult, RepoRunResult, ValidatedSettings } from "../engine/orchestrate.js";
import type { GithubClient } from "../github/api.js";
import type { CollectedLine, Io } from "../io.js";
import type { Private } from "../private.js";
import { revealPrivate } from "../private-open.js";
import { describeProblem } from "../problem.js";
import { type ArtifactUploader, deliverArtifactReport } from "./artifact-report.js";
import { composeReport } from "./composer.js";
import {
  deliverIssueReport,
  type IssueReportMode,
  injectMarkerLabel,
  MARKER_LABEL,
} from "./issue-report.js";

/**
 * A report reaches only a redacted target proven private or internal (flows/deliver.ts decides).
 *
 * `none`              -> delivers nothing
 * `issue`             -> the full report on the private target repo itself, the one GitHub-ACL-private channel a public run has
 * `issue-on-failure`  -> the same issue, created only when the run needs attention; recovery closes it with the healthy report
 * `artifact`          -> the delivered reports as one age-encrypted artifact, for readers with the key but no GitHub access
 */
export const PRIVATE_REPORT_CHANNELS = ["none", "issue", "issue-on-failure", "artifact"] as const;

export type PrivateReportChannel = (typeof PRIVATE_REPORT_CHANNELS)[number];

export type IssueChannel = Extract<PrivateReportChannel, "issue" | "issue-on-failure">;

export function isIssueChannel(channel: PrivateReportChannel): channel is IssueChannel {
  return channel === "issue" || channel === "issue-on-failure";
}

/**
 * One target's rich end state: slug, section outcomes with live detail, and
 * the note for a skip or failure that produced no outcomes. Open in the clear;
 * sealed with the transcript when redacted.
 */
export interface TargetDetail {
  slug: string;
  outcomes: RepoRunResult["outcomes"];
  note?: string;
}

export interface RedactedDetail extends TargetDetail {
  transcript: CollectedLine[];
}

export interface ReportRunMeta {
  /** The admin repository the workflow ran in (GITHUB_REPOSITORY / selfSlug). */
  adminRepo: string;
  /** Link to the workflow run (may be empty on local runs). */
  runUrl: string;
  mode: string;
  /** ISO timestamp captured once at the run's start, passed in (never Date.now here). */
  timestamp: string;
}

/**
 * `on` is false when the channel is off or the target is not redacted. The notice is returned rather than emitted, so
 * the caller can route it through the target's capturing sink.
 */
export function applyMarkerInjection(
  settings: ValidatedSettings,
  on: boolean,
): { settings: ValidatedSettings; notice?: string } {
  if (!on) {
    return { settings };
  }
  // The injection appends MARKER_LABEL_CONFIG (a constant, schema-valid entry) or strips a new_name, both keeping every
  // section shape satisfied, so the brand survives; this cast is the one place that fact is asserted.
  const injection = injectMarkerLabel(settings) as {
    settings: ValidatedSettings;
    outcome: "unchanged" | "injected" | "rename-refused";
  };
  switch (injection.outcome) {
    case "rename-refused":
      return {
        settings: injection.settings,
        notice: `refused to rename the "${MARKER_LABEL}" marker label: private reporting reuses its issue by that exact name, so the rename was dropped`,
      };
    case "unchanged":
      return { settings: injection.settings };
    case "injected":
      return {
        settings: injection.settings,
        notice: `added the "${MARKER_LABEL}" marker label to the managed labels so private reporting can reuse its issue; it is managed like any declared label`,
      };
  }
}

declare const CONCLUDED: unique symbol;

/** The brand makes runOutcome() the only constructor, so the report cannot be told a result and a verdict that disagree. */
export interface RunConclusion {
  readonly result: RepoResult;
  readonly exitCode: 0 | 1;
  readonly [CONCLUDED]: true;
}

interface ReportTarget {
  /** The owner/name pair the issue channel posts into; null when the slug did not parse. */
  repo: RepoRef | null;
  /** The public placeholder, the only name a delivery warning may carry. */
  display: string;
  /** The target's own conclusion; an exit of 1 opens the report issue, 0 closes it. */
  conclusion: RunConclusion;
  detail: Private<RedactedDetail>;
}

/**
 * A delivery failure is one safe warning (placeholder and HTTP status, or the artifact service; never a slug or report
 * content) and never changes any target's result.
 */
export interface ReportChannel {
  deliver(target: ReportTarget): Promise<void>;
  flush(): Promise<void>;
}

/**
 * The flows check for the artifact uploader before any API work (requireUploader); the throw here is the backstop for
 * a caller that skipped that check, an invariant violation and not a run outcome.
 */
export function openReportChannel(
  api: GithubClient,
  channel: PrivateReportChannel,
  meta: ReportRunMeta,
  reportPublicKey: string,
  io: Io,
  uploader?: ArtifactUploader,
): ReportChannel | null {
  switch (channel) {
    case "none":
      return null;
    case "issue":
      return issueChannel(api, meta, "always", io);
    case "issue-on-failure":
      return issueChannel(api, meta, "on-failure", io);
    case "artifact":
      if (uploader === undefined) {
        throw new Error(describeProblem({ code: "artifact-uploader-missing" }));
      }
      return artifactChannel(meta, reportPublicKey, io, uploader);
  }
}

/** The seal opens in full here: the readers are the target repository's own, or hold the artifact's decryption key. */
function composeTargetReport(meta: ReportRunMeta, target: ReportTarget): string {
  const { slug, outcomes, transcript } = revealPrivate(target.detail);
  return composeReport({
    target: slug,
    adminRepo: meta.adminRepo,
    runUrl: meta.runUrl,
    mode: meta.mode,
    result: target.conclusion.result,
    timestamp: meta.timestamp,
    outcomes: outcomes.map((o) => ({ key: o.key, status: o.status, detail: o.detail })),
    transcript,
  });
}

function issueChannel(
  api: GithubClient,
  meta: ReportRunMeta,
  mode: IssueReportMode,
  io: Io,
): ReportChannel {
  return {
    async deliver(target) {
      if (target.repo === null) {
        // The issue channel posts INTO the target repository, and an unparseable slug names none; the loss must not be silent.
        io.annotate(
          "warning",
          `${target.display}: could not deliver the private report: the target name is not an owner/name repository slug, so there is no repository to hold the report issue`,
        );
        return;
      }
      const body = composeTargetReport(meta, target);
      const delivery = await deliverIssueReport(
        api,
        target.repo,
        body,
        target.conclusion.exitCode === 1,
        mode,
      );
      if ("warning" in delivery) {
        io.annotate("warning", `${target.display}: ${delivery.warning}`);
      }
    },
    flush: async () => {},
  };
}

/**
 * Reports accumulate under placeholder headings and leave as one document on flush. The channel never addresses the
 * target repository, so it mirrors even a target whose slug failed to parse.
 */
function artifactChannel(
  meta: ReportRunMeta,
  reportPublicKey: string,
  io: Io,
  uploader: ArtifactUploader,
): ReportChannel {
  const reports: string[] = [];
  return {
    async deliver(target) {
      reports.push(`<!-- ${target.display} -->\n\n${composeTargetReport(meta, target)}`);
    },
    async flush() {
      if (reports.length === 0) {
        return;
      }
      const delivery = await deliverArtifactReport(uploader, reports.join("\n\n"), reportPublicKey);
      if ("warning" in delivery) {
        io.annotate("warning", delivery.warning);
      }
    },
  };
}
