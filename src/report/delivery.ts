/**
 * Private-report delivery, shared by the single- and multi-repo run flows:
 * compose the full unredacted report for a redacted target and hand it to
 * the chosen channel (the target repo's report issue, or the age-encrypted
 * workflow artifact), plus the marker-label injection the issue channel
 * needs so an apply cannot delete the label the report module creates.
 */

import type { IssueChannel } from "../action/redact.js";
import type { RepoRef } from "../discovery/targets.js";
import type { RepoRunResult, ValidatedSettings } from "../engine/orchestrate.js";
import type { GithubClient } from "../github/api.js";
import type { Io } from "../io.js";
import { type ArtifactUploader, deliverArtifactReport } from "./artifact-report.js";
import { composeReport, type TranscriptLine } from "./composer.js";
import {
  deliverIssueReport,
  type IssueReportMode,
  injectMarkerLabel,
  MARKER_LABEL,
} from "./issue-report.js";

/** The run metadata a private report needs, minus the per-target fields. */
export interface ReportRunMeta {
  /** The admin repository the workflow ran in (GITHUB_REPOSITORY / selfSlug). */
  adminRepo: string;
  /** Link to the workflow run (may be empty on local runs). */
  runUrl: string;
  /** "apply" or "check". */
  mode: string;
  /** ISO timestamp captured once at the run's start, passed in (never Date.now here). */
  timestamp: string;
}

/**
 * Apply the marker-label injection for the issue report channel and describe
 * the change. When `on` is false (the channel is off, or the target is not
 * redacted) the settings pass through untouched with no notice. Otherwise
 * injectMarkerLabel appends the report's marker label if the settings declare a
 * labels section and it is absent (or refuses a rename that would move the
 * marker away). The notice is returned rather than emitted, so the caller can
 * route it through the target's capturing sink (the private report).
 */
export function applyMarkerInjection(
  settings: ValidatedSettings,
  on: boolean,
): { settings: ValidatedSettings; notice?: string } {
  if (!on) {
    return { settings };
  }
  // The injection is validity-preserving - it appends MARKER_LABEL_CONFIG (a
  // constant, schema-valid label entry) or strips a new_name, both of which
  // keep every section shape satisfied - so the brand survives it. This is
  // the one place that fact is asserted; the cast below is its whole cost.
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

/**
 * Compose the full unredacted report document for one target. Shared by both
 * delivery channels: the issue channel PATCHes it into the target's report
 * issue, the artifact channel accumulates it for the encrypted upload. The
 * `check` flag decides needsAttention alongside the result (a check-mode drift
 * needs attention; an apply-mode drift cannot occur).
 */
export function composeTargetReport(
  meta: ReportRunMeta,
  slug: string,
  result: RepoRunResult["result"],
  outcomes: RepoRunResult["outcomes"],
  transcript: TranscriptLine[],
  check: boolean,
): { body: string; needsAttention: boolean } {
  const body = composeReport({
    target: slug,
    adminRepo: meta.adminRepo,
    runUrl: meta.runUrl,
    mode: meta.mode,
    result,
    timestamp: meta.timestamp,
    outcomes: outcomes.map((o) => ({ key: o.key, status: o.status, detail: o.detail })),
    transcript,
  });
  const needsAttention = result === "failed" || (check && result === "drift");
  return { body, needsAttention };
}

/**
 * Compose the full unredacted report for a redacted target and deliver it to
 * the issue channel. Under `always` this runs on EVERY result (the report is
 * the private mirror of the run log); under `on-failure` a healthy run at
 * most closes a leftover open issue and its no-op skip is silent. Returns a
 * safe summary-row note on delivery failure - and emits one public-safe
 * warning naming only the placeholder and the HTTP status - or undefined on
 * success; the target's result is never changed either way.
 */
export async function deliverReport(
  api: GithubClient,
  meta: ReportRunMeta,
  repo: RepoRef,
  display: string,
  result: RepoRunResult["result"],
  outcomes: RepoRunResult["outcomes"],
  transcript: TranscriptLine[],
  check: boolean,
  channel: IssueChannel,
  io: Io,
): Promise<string | undefined> {
  const { body, needsAttention } = composeTargetReport(
    meta,
    repo.slug,
    result,
    outcomes,
    transcript,
    check,
  );
  // The one channel-to-mode conversion, exhaustive over IssueChannel: a future
  // issue channel fails to compile here instead of inheriting a default.
  let mode: IssueReportMode;
  switch (channel) {
    case "issue":
      mode = "always";
      break;
    case "issue-on-failure":
      mode = "on-failure";
      break;
  }
  const delivery = await deliverIssueReport(api, repo, body, needsAttention, mode);
  if ("warning" in delivery) {
    io.annotate("warning", `${display}: ${delivery.warning}`);
    return delivery.warning;
  }
  return undefined;
}

/**
 * Concatenate every accumulated per-target report into one document, encrypt it
 * to the operator's recipient, and upload it as the single workflow artifact.
 * A no-op when no report was accumulated. Delivery failure warns safely (the
 * artifact service or missing runtime token, never a slug or report content)
 * and leaves the run result untouched. `uploader` is the injectable test
 * port; production passes undefined and the real @actions/artifact
 * uploader applies.
 */
export async function uploadArtifactReport(
  reports: Array<{ display: string; body: string }>,
  reportPublicKey: string,
  io: Io,
  uploader?: ArtifactUploader,
): Promise<void> {
  if (reports.length === 0) {
    return;
  }
  const document = concatArtifactReports(reports);
  const delivery = await deliverArtifactReport(document, reportPublicKey, uploader);
  if ("warning" in delivery) {
    io.annotate("warning", delivery.warning);
  }
}

/**
 * Join accumulated per-target reports into one document, each under a heading
 * carrying its public placeholder (the document itself is private, but the
 * heading is the only added text and stays placeholder-keyed for consistency
 * with the public surfaces).
 */
function concatArtifactReports(reports: Array<{ display: string; body: string }>): string {
  return reports.map((report) => `<!-- ${report.display} -->\n\n${report.body}`).join("\n\n");
}
