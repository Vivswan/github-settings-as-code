/**
 * Where every run ends. Each target closes its channel and delivers here, and the summary, outputs, and exit code are
 * decided here, so the single- and multi-repo flows cannot drift in what they report.
 */

import { err, ok, type Result } from "neverthrow";
import type { RepoRef } from "../discovery/targets.js";
import {
  type RepoResult,
  type RepoRunResult,
  type SectionOutcome,
  skippedSectionKeys,
  worstOf,
} from "../engine/orchestrate.js";
import type { SectionSelection } from "../engine/section-selection.js";
import type { GithubClient } from "../github/api.js";
import type { RepoVisibility } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import { isPrivate } from "../private.js";
import { describeProblem, type Problem, type ProblemOf } from "../problem.js";
import type { ArtifactUploader } from "../report/artifact-report.js";
import {
  isIssueChannel,
  openReportChannel,
  type PrivateReportChannel,
  type RunConclusion,
} from "../report/delivery.js";
import {
  emitRedactedResult,
  isPrivateVisibility,
  type PrivateReposPolicy,
  type PublicTargetView,
  publicDetail,
  type TargetChannel,
  type TargetOutcome,
  toPublicView,
  WITHHELD_REPORT_NOTICE,
} from "./redact.js";
import { writeMergeSummary, writeMultiSummary, writeSummary } from "./summary.js";

export interface TargetResult {
  result: RepoResult;
  outcomes: SectionOutcome[];
  /** Human line for skips/failures that produced no section outcomes. */
  note?: string;
}

export function failedTarget(message: string): TargetResult {
  return { result: "failed", outcomes: [], note: message };
}

/** A failure before the engine ran; the rich message goes to the target's channel (public in the clear, captured when redacted). */
export function targetFailure(channelIo: Io, richMessage: string): TargetResult {
  channelIo.annotate("error", richMessage);
  return failedTarget(richMessage);
}

/** A preflight denial refused to write anything; its one line goes through the channel and its note heads the target's otherwise empty summary. */
export function engineOutcome(run: RepoRunResult, channelIo: Io): TargetResult {
  const denied = run.preflightDenied.length;
  if (denied === 0) {
    return { result: run.result, outcomes: run.outcomes };
  }
  channelIo.annotate(
    "error",
    `preflight failed: the token cannot access ${denied} section(s), so nothing was applied to this repository. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`,
  );
  return {
    result: run.result,
    outcomes: run.outcomes,
    note: `preflight denied ${denied} section(s); nothing was applied to this repository`,
  };
}

/**
 * The one outcome predicate: the run exits 1 exactly when the worst target result is failed or a check-mode drift. A
 * single target's report opens under the same rule.
 */
export function runOutcome(
  results: ReadonlyArray<{ result: RepoResult }>,
  check: boolean,
): RunConclusion {
  const result = worstOf([...results], check);
  const exitCode = result === "failed" || (check && result === "drift") ? 1 : 0;
  return { result, exitCode } as RunConclusion;
}

export interface DeliveryConfig {
  mode: "apply" | "check";
  privateReport: PrivateReportChannel;
  /** The age recipient the `artifact` channel encrypts every report to; empty for the other channels. */
  reportPublicKey: string;
  /** The repository the run acts for; a target equal to it is never redacted. */
  selfSlug: string;
  /** Link to the workflow run, for the private report metadata; may be empty. */
  runUrl: string;
}

export interface RunFlowConfig extends DeliveryConfig {
  onMissingPermission: "fail" | "warn";
  sections: SectionSelection;
  /** Whether to hide private/internal targets from the public view. */
  privateRepos: PrivateReposPolicy;
}

/** Both flows check this before any API work; openReportChannel asserts the same rule as its backstop. */
export function requireUploader(
  cfg: Pick<DeliveryConfig, "privateReport">,
  uploader: ArtifactUploader | undefined,
): Result<void, ProblemOf<"artifact-uploader-missing">> {
  return cfg.privateReport === "artifact" && uploader === undefined
    ? err({ code: "artifact-uploader-missing" })
    : ok();
}

export type Exposure = { kind: "shown" } | { kind: "redacted"; visibility: RepoVisibility };

/** One target as it enters delivery; `repo` is null when the slug did not parse (the issue channel has nowhere to post). */
export interface OpenedTarget {
  repo: RepoRef | null;
  channel: TargetChannel;
  exposure: Exposure;
}

export interface Delivery {
  /**
   * `work` is told whether to inject the issue channel's marker label. On close, a redacted target proven private or
   * internal gets its report, an unproven one the withheld notice, and its public line is closed-value only.
   */
  target(
    opened: OpenedTarget,
    work: (injectsMarker: boolean) => Promise<TargetResult>,
  ): Promise<Omit<TargetOutcome, "source">>;
}

/** The delivery is flushed even when `body` throws: the artifact channel uploads every accumulated report as ONE document there. */
export async function withDelivery<T>(
  run: { api: GithubClient; cfg: DeliveryConfig; io: Io; uploader?: ArtifactUploader },
  body: (delivery: Delivery) => Promise<T>,
): Promise<T> {
  const { api, cfg, io, uploader } = run;
  const check = cfg.mode === "check";
  const meta = {
    adminRepo: cfg.selfSlug,
    runUrl: cfg.runUrl,
    mode: cfg.mode,
    timestamp: new Date().toISOString(),
  };
  const reports = openReportChannel(
    api,
    cfg.privateReport,
    meta,
    cfg.reportPublicKey,
    io,
    uploader,
  );
  // Redaction fails closed (hidden unless proven public), but delivery fails closed the other way: a report reaches a
  // target only when it is proven private or internal, never one that might be public.
  const deliverable = (exposure: Exposure): boolean =>
    reports !== null && exposure.kind === "redacted" && isPrivateVisibility(exposure.visibility);
  const delivery: Delivery = {
    async target({ repo, channel, exposure }, work) {
      const outcome = await work(deliverable(exposure) && isIssueChannel(cfg.privateReport));
      const detail = channel.close(outcome.outcomes, outcome.note);
      if (isPrivate(detail)) {
        if (reports !== null && !deliverable(exposure)) {
          io.annotate("notice", `${channel.display}: ${WITHHELD_REPORT_NOTICE}`);
        } else if (reports !== null) {
          await reports.deliver({
            repo,
            display: channel.display,
            conclusion: runOutcome([outcome], check),
            detail,
          });
        }
        emitRedactedResult(io, channel.display, outcome.result, detail);
      }
      return { result: outcome.result, display: channel.display, detail };
    },
  };
  try {
    return await body(delivery);
  } finally {
    // The artifact's single upload deliberately follows every target's public line (each is redaction-safe on its own);
    // a crash still flushes what accumulated.
    await reports?.flush();
  }
}

export type FinishedRun =
  | { kind: "single"; mode: DeliveryConfig["mode"]; target: Omit<TargetOutcome, "source"> }
  | { kind: "multi"; mode: DeliveryConfig["mode"]; targets: TargetOutcome[] };

/** The public view is projected first, so nothing below carries a redacted slug. */
export function concludeRun(io: Io, run: FinishedRun): number {
  if (run.kind === "single") {
    const view = publicDetail(run.target.detail);
    writeSummary(io, view, run.mode, run.target.result);
    return conclude(io, [{ ...view, result: run.target.result }], run.mode === "check");
  }
  const views: PublicTargetView[] = run.targets.map(toPublicView);
  writeMultiSummary(io, views, run.mode);
  io.output(
    "repos-result",
    JSON.stringify(
      Object.fromEntries(
        views.map((v) => [
          v.display,
          { result: v.result, source: v.source, skippedSections: skippedSectionKeys(v.outcomes) },
        ]),
      ),
    ),
  );
  return conclude(io, views, run.mode === "check");
}

/**
 * A run that failed before any target ran gets a failed target's conclusion and no summary; the one place a fatal problem becomes text.
 * `describe` is the action's wording unless the caller's face (the command line) words a remedy differently.
 */
export function failRun(
  io: Io,
  problem: Problem,
  describe: (problem: Problem) => string = describeProblem,
): number {
  const message = describe(problem);
  io.annotate("error", message);
  // The mode may be unknown here (a config error); a failure exits 1 under either.
  return conclude(io, [failedTarget(message)], false);
}

/** Not a RepoResult: a merge has no target, so it never enters worstOf and never appears beside the per-repo values. */
export const MERGE_RESULT = "merged";

export interface FinishedMerge {
  layers: readonly string[];
  mergedFile: string;
}

export function concludeMerge(io: Io, run: FinishedMerge): number {
  writeMergeSummary(io, run.layers, run.mergedFile);
  io.log(`merged ${run.layers.length} layer(s) into ${run.mergedFile}`);
  io.output("skipped-sections", "");
  io.output("result", MERGE_RESULT);
  io.log(`result: ${MERGE_RESULT}`);
  return 0;
}

function conclude(
  io: Io,
  results: ReadonlyArray<{
    result: RepoResult;
    outcomes: ReadonlyArray<Pick<SectionOutcome, "key" | "status">>;
  }>,
  check: boolean,
): number {
  io.output(
    "skipped-sections",
    [...new Set(results.flatMap((r) => skippedSectionKeys(r.outcomes)))].join(","),
  );
  const { result, exitCode } = runOutcome(results, check);
  io.output("result", result);
  io.log(`result: ${result}`);
  return exitCode;
}
