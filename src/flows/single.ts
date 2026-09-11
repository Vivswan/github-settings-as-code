/**
 * The single-repo run flow: one local settings file applied to, or checked
 * against, one repository. The file is operator-authored, so its read, parse,
 * and validation errors name only the local path and never redact. Only the
 * engine's live-value output and the fail/preflight annotations can carry the
 * target's state, so those go through the target's channel, which captures
 * them when the target is a different, non-public repository.
 */

import { ResultAsync } from "neverthrow";
import type { RepoRef } from "../discovery/targets.js";
import { runForRepo, type ValidatedSettings, validateSettingsDoc } from "../engine/orchestrate.js";
import type { GithubClient } from "../github/api.js";
import { createVisibilityResolver } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import type { Problem } from "../problem.js";
import type { ArtifactUploader } from "../report/artifact-report.js";
import { applyMarkerInjection } from "../report/delivery.js";
import {
  type Exposure,
  engineOutcome,
  failedTarget,
  type RunFlowConfig,
  requireUploader,
  withDelivery,
} from "./deliver.js";
import {
  attempt,
  publicChannel,
  redactedChannel,
  type TargetChannel,
  type TargetOutcome,
} from "./redact.js";
import { readSettingsFile } from "./settings-read.js";

export interface SingleConfig extends RunFlowConfig {
  repo: RepoRef;
  /** The local settings file, read and validated before the target is touched. */
  settingsFile: string;
}

/**
 * Open the single-repo target's channel, masking its slug when redacted.
 * Redaction fails closed: the target is hidden unless the probe proves it
 * public (the self repository and the `show` policy skip the probe).
 */
async function openSingleRepoChannel(
  api: GithubClient,
  cfg: Pick<SingleConfig, "privateRepos" | "repo" | "selfSlug">,
  io: Io,
): Promise<{ channel: TargetChannel; exposure: Exposure }> {
  const shown = (): { channel: TargetChannel; exposure: Exposure } => ({
    channel: publicChannel(io, cfg.repo.slug, false),
    exposure: { kind: "shown" },
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
    exposure: { kind: "redacted", visibility },
  };
}

/** The one target's outcome; the source is implied (the local settings file). */
export type SingleOutcome = Omit<TargetOutcome, "source">;

/**
 * Run one repository from its settings file. A problem before the target runs
 * (no uploader for the artifact channel, an unreadable or invalid settings
 * file) comes back as the error; otherwise the target's outcome, which
 * concludeRun turns into the summary, the outputs, and the exit code.
 */
export function runSingle(
  api: GithubClient,
  cfg: SingleConfig,
  io: Io,
  uploader?: ArtifactUploader,
): ResultAsync<SingleOutcome, Problem> {
  return requireUploader(cfg, uploader)
    .andThen(() => readSettingsFile(cfg.settingsFile, "settings-file"))
    .andThen((doc) => validateSettingsDoc(doc, cfg.settingsFile, cfg.onlySections, io))
    .asyncAndThen((settings) =>
      ResultAsync.fromSafePromise(runTarget(api, cfg, io, settings, uploader)),
    );
}

/** The target's run, past every check that could refuse it: open its channel, run, deliver. */
async function runTarget(
  api: GithubClient,
  cfg: SingleConfig,
  io: Io,
  settings: ValidatedSettings,
  uploader: ArtifactUploader | undefined,
): Promise<SingleOutcome> {
  const opened = await openSingleRepoChannel(api, cfg, io);
  const { channel } = opened;
  return withDelivery({ api, cfg, io, uploader }, (delivery) =>
    delivery.target({ repo: cfg.repo, ...opened }, (injectsMarker) => {
      const injected = applyMarkerInjection(settings, injectsMarker);
      if (injected.notice) {
        channel.io.annotate("notice", injected.notice);
      }
      return attempt(
        channel,
        async () =>
          engineOutcome(
            await runForRepo(
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
            channel.io,
          ),
        failedTarget,
      );
    }),
  );
}
