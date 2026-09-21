/**
 * Where every run ends. Each target, whatever its mode, closes its channel here (closeTarget), the run flows deliver
 * their private reports here, and the summary, outputs, and exit code are decided here, so the flows cannot drift in
 * what they report.
 */

import type { RepoRef, Target } from "../discovery/targets.js";
import {
  type RepoRunResult,
  type SectionOutcome,
  skippedSectionKeys,
} from "../engine/orchestrate.js";
import { type RunOutcome, worstOf } from "../engine/outcome.js";
import type { SectionSelection } from "../engine/section-selection.js";
import type { SectionSnapshotOutcome } from "../engine/snapshot.js";
import type { GitHubClient } from "../github/api.js";
import type { RepoVisibility } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import { isPrivate, type Private } from "../private.js";
import { describeProblem, type Problem } from "../problem.js";
import type { ArtifactUploader } from "../report/artifact-report.js";
import {
  type ClosedOutcome,
  isIssueChannel,
  openReportChannel,
  type PrivateReportChannel,
  type RedactedDetail,
  type RunConclusion,
} from "../report/delivery.js";
import type { SectionKey } from "../schema.js";
import { countNoun } from "../text.js";
import type { UndeclaredPolicy } from "../types.js";
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
import { writeMultiSummary, writeRenderSummary, writeSummary } from "./summary.js";

/** One target's end state as its flow hands it over: the result word plus everything the channel seals. */
export interface TargetResult {
  result: RunOutcome;
  outcomes: ClosedOutcome[];
  /** Human line for skips/failures that produced no section outcomes, or where a snapshot's file went. */
  note?: string;
  /** The snapshot file the target wrote; absent when nothing was written. */
  file?: string;
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
    `preflight failed: the token cannot access ${countNoun(denied, "section", "sections")}, so nothing was applied to this repository. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`,
  );
  return {
    result: run.result,
    outcomes: run.outcomes,
    note: `preflight denied ${countNoun(denied, "section", "sections")}; nothing was applied to this repository`,
  };
}

/**
 * The one outcome predicate: the run exits 1 exactly when the worst target result is failed or a check-mode drift. A
 * single target's report opens under the same rule.
 */
export function runOutcome(
  results: ReadonlyArray<{ result: RunOutcome }>,
  check: boolean,
): RunConclusion {
  const result = worstOf(results);
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
  /** The `undeclared` input: the fallback policy below a list's wrapper and the file's top-level `_undeclared`; unset by default. */
  undeclared?: UndeclaredPolicy | undefined;
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

/**
 * Where every target ends, in every mode: the channel closes its end state (sealed when redacted), `report` sees a
 * sealed detail before the target's one closed-value line is spoken, and the outcome carries only the public label and
 * the detail the projections open. A mode without a report channel (snapshot) passes no `report`.
 */
export async function closeTarget(
  io: Io,
  channel: TargetChannel,
  outcome: TargetResult,
  report?: (detail: Private<RedactedDetail>) => Promise<void>,
): Promise<Omit<TargetOutcome, "source">> {
  const detail = channel.close(outcome);
  if (isPrivate(detail)) {
    await report?.(detail);
    emitRedactedResult(io, channel.display, outcome.result, detail);
  }
  return { result: outcome.result, display: channel.display, detail };
}

/** The delivery is flushed even when `body` throws: the artifact channel uploads every accumulated report as ONE document there. */
export async function withDelivery<T>(
  run: { api: GitHubClient; cfg: DeliveryConfig; io: Io; uploader?: ArtifactUploader },
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
      return closeTarget(io, channel, outcome, async (detail) => {
        if (reports === null) {
          return;
        }
        if (!deliverable(exposure)) {
          io.annotate("notice", `${channel.display}: ${WITHHELD_REPORT_NOTICE}`);
          return;
        }
        await reports.deliver({
          repo,
          display: channel.display,
          conclusion: runOutcome([outcome], check),
          detail,
        });
      });
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
    return conclude(io, { ...view, result: run.target.result }, run.mode === "check");
  }
  const views: PublicTargetView[] = run.targets.map(toPublicView);
  writeMultiSummary(io, views, run.mode);
  return conclude(io, views, run.mode === "check");
}

/**
 * A run that failed before any target ran gets a failed target's conclusion and no summary; the one place a fatal
 * problem becomes text, in the one wording both faces print.
 */
export function failRun(io: Io, problem: Problem): number {
  const message = describeProblem(problem);
  io.annotate("error", message);
  // The mode may be unknown here (a config error); a failure exits 1 under either.
  return conclude(io, failedTarget(message), false);
}

export interface FinishedRender {
  layers: readonly string[];
  renderedFile: string;
}

export function concludeRender(io: Io, run: FinishedRender): number {
  writeRenderSummary(io, run.layers, run.renderedFile);
  io.log(`rendered ${countNoun(run.layers.length, "layer", "layers")} into ${run.renderedFile}`);
  return conclude(io, { result: "rendered", outcomes: [] }, false);
}

/** One target as the outputs see it: its result and the closed section statuses `skipped-sections` is filtered from. */
export interface ConcludedTarget {
  result: RunOutcome;
  outcomes: ReadonlyArray<{
    key: SectionKey;
    status: SectionOutcome["status"] | SectionSnapshotOutcome["status"];
  }>;
}

/** A fleet target, keyed into `repos-result` by its public label (the slug, or its "private repository #N" placeholder). */
export interface ConcludedFleetTarget extends ConcludedTarget {
  display: string;
  source?: Target["source"];
}

/**
 * Where every mode ends: the three outputs, always all three, then the result line and the exit code. A run over one
 * target (single, merge, snapshot-file, a fatal problem) has no fleet, so its `repos-result` is the empty map; a fleet
 * (multi, snapshot-dir) maps every target's label to its own row, spelled in the outputs' kebab-case.
 */
export function conclude(
  io: Io,
  run: ConcludedTarget | readonly ConcludedFleetTarget[],
  check: boolean,
): number {
  const targets = Array.isArray(run) ? run : [run];
  const fleet: ReadonlyArray<ConcludedFleetTarget> = Array.isArray(run) ? run : [];
  const { result, exitCode } = runOutcome(targets, check);
  io.output("result", result);
  io.output(
    "skipped-sections",
    [...new Set(targets.flatMap((target) => skippedSectionKeys(target.outcomes)))].join(","),
  );
  io.output(
    "repos-result",
    JSON.stringify(
      Object.fromEntries(
        fleet.map((target) => [
          target.display,
          {
            result: target.result,
            source: target.source,
            "skipped-sections": skippedSectionKeys(target.outcomes),
          },
        ]),
      ),
    ),
  );
  io.log(`result: ${result}`);
  return exitCode;
}
