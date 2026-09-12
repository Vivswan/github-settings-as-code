/**
 * The single-repo run flow. The file is operator-authored, so its read, parse, and validation errors name only the local
 * path and never redact; only the engine's output and the fail/preflight annotations can carry the target's state, so
 * those go through the target's channel, which captures them when the target is a different, non-public repository.
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
  settingsFile: string;
}

/** Redaction fails closed: the target is hidden unless the probe proves it public (the self repository and the `show` policy skip the probe). */
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

export type SingleOutcome = Omit<TargetOutcome, "source">;

export function runSingle(
  api: GithubClient,
  cfg: SingleConfig,
  io: Io,
  uploader?: ArtifactUploader,
): ResultAsync<SingleOutcome, Problem> {
  return requireUploader(cfg, uploader)
    .andThen(() => readSettingsFile(cfg.settingsFile, "settings-file"))
    .andThen((doc) => validateSettingsDoc(doc, cfg.settingsFile, cfg.sections.only, io))
    .asyncAndThen((settings) =>
      ResultAsync.fromSafePromise(runTarget(api, cfg, io, settings, uploader)),
    );
}

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
                sections: cfg.sections,
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
