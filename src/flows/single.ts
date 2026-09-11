/**
 * The single-repo run flow: one local settings file applied to, or checked
 * against, one repository. The file is operator-authored, so its read, parse,
 * and validation errors name only the local path and never redact. Only the
 * engine's live-value output and the fail/preflight annotations can carry the
 * target's state, so those go through the target's channel, which captures
 * them when the target is a different, non-public repository.
 */

import type { RepoRef } from "../discovery/targets.js";
import { runForRepo, validateSettingsDoc } from "../engine/orchestrate.js";
import type { GithubClient } from "../github/api.js";
import { createVisibilityResolver } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import type { ArtifactUploader } from "../report/artifact-report.js";
import { applyMarkerInjection } from "../report/delivery.js";
import {
  type Exposure,
  engineOutcome,
  failedTarget,
  missingUploaderProblem,
  type RunFlowConfig,
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

/**
 * Run one repository from its settings file. A problem before the target runs
 * (no uploader for the artifact channel, an unreadable or invalid settings
 * file) is `fatal`; otherwise the target's outcome, which concludeRun turns
 * into the summary, the outputs, and the exit code.
 */
export async function runSingle(
  api: GithubClient,
  cfg: SingleConfig,
  io: Io,
  uploader?: ArtifactUploader,
): Promise<{ fatal: string } | { target: Omit<TargetOutcome, "source"> }> {
  const noUploader = missingUploaderProblem(cfg, uploader);
  if (noUploader !== null) {
    return { fatal: noUploader };
  }
  const read = readSettingsFile(cfg.settingsFile);
  if ("error" in read) {
    return {
      fatal: `cannot read settings from ${cfg.settingsFile}: ${read.error}. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML`,
    };
  }
  const validated = validateSettingsDoc(read.doc, cfg.settingsFile, cfg.onlySections, io);
  if ("error" in validated) {
    return { fatal: validated.error };
  }

  const opened = await openSingleRepoChannel(api, cfg, io);
  const { channel } = opened;
  const target = await withDelivery({ api, cfg, io, uploader }, (delivery) =>
    delivery.target({ repo: cfg.repo, ...opened }, (injectsMarker) => {
      const injected = applyMarkerInjection(validated.settings, injectsMarker);
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
  return { target };
}
