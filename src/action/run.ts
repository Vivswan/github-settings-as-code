/**
 * github-settings-as-code: apply a declarative .github/settings.yml to the repo.
 *
 * Policy model:
 * - mode: apply (default) mutates; check reports drift and exits 1 on any.
 * - on-missing-permission: fail (default) | warn. Under warn, a section the
 *   token cannot touch is skipped with a warning and the run stays green
 *   (partial success) - unless the section is listed in required-sections.
 * - Non-permission errors always fail, loudly, with the API message.
 *
 * Multi-repo mode (repos / repos-dir / defaults-file inputs): one run in an
 * admin repo applies settings to many repositories - from per-repo files
 * checked into the admin repo (central), or from each target's own
 * .github/settings.yml (remote), with an optional defaults layer merged
 * under every target. Targets run independently; the run fails at the end
 * if any target failed.
 */

import type { RepoRef } from "../discovery/targets.js";
import {
  type RepoRunResult,
  runForRepo,
  skippedSectionKeys,
  validateSettingsDoc,
  worstOf,
} from "../engine/orchestrate.js";
import { GithubApi, type GithubClient } from "../github/api.js";
import { createVisibilityResolver } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import { isPrivate } from "../private.js";
import { deliverArtifactReport } from "../report/artifact-report.js";
import { applyMarkerInjection, composeTargetReport, deliverReport } from "../report/delivery.js";
import { parseConfig } from "./inputs.js";
import { actionsIo } from "./io.js";
import { runMulti } from "./multi.js";
import {
  attempt,
  isIssueChannel,
  isPrivateVisibility,
  publicChannel,
  publicDetail,
  REDACTED_NOTE,
  redactedChannel,
  type TargetChannel,
  toPublicView,
  WITHHELD_REPORT_NOTICE,
} from "./redact.js";
import { readSettingsFile } from "./settings-read.js";
import { writeMultiSummary, writeSummary } from "./summary.js";

/**
 * Open the single-repo target's channel, masking its slug when redacted. Both
 * decisions fail closed in opposite directions: redact unless the probe proves
 * the repo public, deliver the report only when it proves it private/internal.
 */
async function openSingleRepoChannel(
  api: GithubClient,
  cfg: { privateRepos: string; repo: RepoRef; selfSlug: string },
  io: Io,
): Promise<{ channel: TargetChannel; deliverable: boolean }> {
  const shown = (): { channel: TargetChannel; deliverable: boolean } => ({
    channel: publicChannel(io, cfg.repo.slug, false),
    deliverable: false,
  });
  if (cfg.privateRepos !== "redact") {
    return shown();
  }
  if (cfg.repo.slug.toLowerCase() === cfg.selfSlug.toLowerCase()) {
    return shown();
  }
  const visibility = await createVisibilityResolver(api)(cfg.repo.slug);
  if (visibility === "public") {
    return shown();
  }
  io.mask(cfg.repo.slug);
  return {
    channel: redactedChannel(io, cfg.repo.slug, "private repository"),
    deliverable: isPrivateVisibility(visibility),
  };
}

/**
 * Execute the action; returns the process exit code. `overrides` exists for
 * tests: a stub client instead of the real API, and a capturing Io instead of
 * the @actions/core sink (production always uses the defaults).
 */
export async function run(overrides?: { api?: GithubClient; io?: Io }): Promise<number> {
  const io = overrides?.io ?? actionsIo;
  const fail = (message: string): number => {
    io.annotate("error", message);
    io.output("result", "failed");
    return 1;
  };

  const parsed = parseConfig();
  if ("error" in parsed) {
    return fail(parsed.error);
  }
  const cfg = parsed.config;
  const api = overrides?.api ?? new GithubApi(cfg.token, io, undefined, cfg.apiVersion);

  if (cfg.kind === "multi") {
    const { fatal, targets } = await runMulti(api, cfg, io);
    if (fatal) {
      return fail(fatal);
    }
    // The public view strips private detail and keys by the display label,
    // so nothing written past this point can carry a redacted slug.
    const views = targets.map(toPublicView);
    writeMultiSummary(io, views, cfg.mode);
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
    io.output(
      "skipped-sections",
      [...new Set(views.flatMap((v) => skippedSectionKeys(v.outcomes)))].join(","),
    );
    const overall = worstOf(views, cfg.mode === "check");
    io.output("result", overall);
    io.log(`result: ${overall}`);
    // The exit code follows the same worst-of ranking the output reports.
    return overall === "failed" || (cfg.mode === "check" && overall === "drift") ? 1 : 0;
  }

  // Single-repo mode. The settings file is local and operator-authored, so
  // read/parse/validate errors name only the local path and never redact.
  // Only the engine's live-value output and the fail/preflight annotations
  // can carry the private target's state, so those go through the channel,
  // which captures them when the target is a different, non-public repository.
  const read = readSettingsFile(cfg.settingsFile);
  if ("error" in read) {
    return fail(
      `cannot read settings from ${cfg.settingsFile}: ${read.error}. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML`,
    );
  }
  const validated = validateSettingsDoc(read.doc, cfg.settingsFile, cfg.onlySections, io);
  if ("error" in validated) {
    return fail(validated.error);
  }
  const settings = validated.settings;

  const { channel, deliverable } = await openSingleRepoChannel(api, cfg, io);

  // Report channel: for a redacted single-repo target proven private, deliver
  // the full report to the target repo's own issue or the encrypted artifact,
  // exactly as multi mode does. The channel's transcript feeds the report; the
  // marker-label injection (issue channel only) keeps an apply from deleting
  // the label the report module creates.
  const reportOn = deliverable && cfg.privateReport !== "none";
  const injected = applyMarkerInjection(settings, reportOn && isIssueChannel(cfg.privateReport));
  if (injected.notice) {
    channel.io.annotate("notice", injected.notice);
  }

  const result = await attempt(
    channel,
    () =>
      runForRepo(
        api,
        {
          repo: cfg.repo,
          settings: injected.settings,
          mode: cfg.mode,
          onMissingPermission: cfg.onMissingPermission,
          requiredSections: cfg.requiredSections,
          onlySections: cfg.onlySections,
        },
        channel.io,
      ),
    (): RepoRunResult => ({
      repo: cfg.repo.slug,
      result: "failed",
      outcomes: [],
      preflightDenied: [],
    }),
  );
  const detail = channel.close(result.outcomes);

  // The private report mirrors the run log, so it is delivered on EVERY
  // result (a preflight failure included); its own failure only warns.
  if (isPrivate(detail) && cfg.privateReport !== "none") {
    if (!deliverable) {
      // Redacted but not proven private: the report is withheld, said once,
      // safely (the cause and fix are slug-free; the placeholder stays).
      io.annotate("notice", `${channel.display}: ${WITHHELD_REPORT_NOTICE}`);
    } else {
      const meta = {
        adminRepo: cfg.selfSlug,
        runUrl: cfg.runUrl,
        mode: cfg.mode,
        timestamp: new Date().toISOString(),
      };
      if (cfg.privateReport === "artifact") {
        const { body } = composeTargetReport(meta, result.result, detail, cfg.mode === "check");
        const delivery = await deliverArtifactReport(body, cfg.reportPublicKey);
        if ("warning" in delivery) {
          io.annotate("warning", delivery.warning);
        }
      } else if (isIssueChannel(cfg.privateReport)) {
        await deliverReport(
          api,
          meta,
          cfg.repo,
          channel.display,
          result.result,
          detail,
          cfg.mode === "check",
          cfg.privateReport,
          io,
        );
      }
    }
  }

  // A redacted target's engine lines were captured, so its public failure
  // lines carry the generic note where a target in the clear points at the
  // annotations above.
  if (result.preflightDenied.length > 0) {
    return fail(
      isPrivate(detail)
        ? `preflight failed. ${REDACTED_NOTE}`
        : `preflight failed: the token cannot access ${result.preflightDenied.length} section(s), so nothing was applied. Grant the permissions named above, or set on-missing-permission: warn to skip those sections`,
    );
  }

  const shown = publicDetail(detail);
  writeSummary(io, shown, cfg.mode, result.result);
  io.output("skipped-sections", skippedSectionKeys(shown.outcomes).join(","));

  if (result.result === "failed") {
    if (isPrivate(detail)) {
      io.annotate("error", `failed. ${REDACTED_NOTE}`);
    }
    io.output("result", "failed");
    return 1;
  }
  io.output("result", result.result);
  io.log(`result: ${result.result}`);
  return result.result === "drift" ? 1 : 0;
}
