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
import { runForRepo, validateSettingsDoc } from "../engine/orchestrate.js";
import { GithubApi, type GithubClient } from "../github/api.js";
import { createVisibilityResolver } from "../github/repo-visibility.js";
import type { Io } from "../io.js";
import type { ArtifactUploader } from "../report/artifact-report.js";
import { applyMarkerInjection } from "../report/delivery.js";
import {
  concludeRun,
  type Exposure,
  engineOutcome,
  failedTarget,
  failRun,
  withDelivery,
} from "./deliver.js";
import { parseConfig } from "./inputs.js";
import { actionsIo } from "./io.js";
import { runMulti } from "./multi.js";
import { attempt, publicChannel, redactedChannel, type TargetChannel } from "./redact.js";
import { readSettingsFile } from "./settings-read.js";

/**
 * Open the single-repo target's channel, masking its slug when redacted.
 * Redaction fails closed: the target is hidden unless the probe proves it
 * public (the self repository and the `show` policy skip the probe).
 */
async function openSingleRepoChannel(
  api: GithubClient,
  cfg: { privateRepos: string; repo: RepoRef; selfSlug: string },
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
 * Execute the action; returns the process exit code. `overrides` exists for
 * tests (a stub client, a capturing Io, a capturing uploader); production uses the defaults.
 */
export async function run(overrides?: {
  api?: GithubClient;
  io?: Io;
  uploader?: ArtifactUploader;
}): Promise<number> {
  const io = overrides?.io ?? actionsIo;

  const parsed = parseConfig();
  if ("error" in parsed) {
    return failRun(io, parsed.error);
  }
  const cfg = parsed.config;
  const api = overrides?.api ?? new GithubApi(cfg.token, io, undefined, cfg.apiVersion);

  if (cfg.kind === "multi") {
    const { fatal, targets } = await runMulti(api, cfg, io, overrides?.uploader);
    if (fatal) {
      return failRun(io, fatal);
    }
    return concludeRun(io, { kind: "multi", mode: cfg.mode, targets });
  }

  // Single-repo mode. The settings file is local and operator-authored, so
  // read/parse/validate errors name only the local path and never redact.
  // Only the engine's live-value output and the fail/preflight annotations
  // can carry the private target's state, so those go through the channel,
  // which captures them when the target is a different, non-public repository.
  const read = readSettingsFile(cfg.settingsFile);
  if ("error" in read) {
    return failRun(
      io,
      `cannot read settings from ${cfg.settingsFile}: ${read.error}. Check that the file exists at that path (set the "settings-file" input if it lives elsewhere) and is valid YAML`,
    );
  }
  const validated = validateSettingsDoc(read.doc, cfg.settingsFile, cfg.onlySections, io);
  if ("error" in validated) {
    return failRun(io, validated.error);
  }

  const opened = await openSingleRepoChannel(api, cfg, io);
  const { channel } = opened;
  const target = await withDelivery({ api, cfg, io, uploader: overrides?.uploader }, (delivery) =>
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
  return concludeRun(io, { kind: "single", mode: cfg.mode, target });
}
