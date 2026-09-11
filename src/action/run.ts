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
 * .github/settings.yml (remote), or the defaults-file document for a
 * remote target that has no file. Targets run independently; the run fails
 * at the end if any target failed.
 *
 * mode: merge folds an ordered list of settings files into one document
 * written to merged-file, for a later apply or check step to run; it never
 * touches GitHub (src/flows/merge.ts).
 */

import {
  type ArtifactUploader,
  concludeMerge,
  concludeRun,
  failRun,
  GithubApi,
  type GithubClient,
  type Io,
  runMerge,
  runMulti,
  runSingle,
} from "../index.js";
import { actionsArtifactUploader } from "./artifact.js";
import { parseConfig } from "./inputs.js";
import { actionsIo } from "./io.js";

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
  const uploader = overrides?.uploader ?? actionsArtifactUploader;

  const parsed = parseConfig();
  if (parsed.isErr()) {
    return failRun(io, parsed.error);
  }
  const cfg = parsed.value;
  // A merge folds local files only: no client is built, so no token is read.
  if (cfg.kind === "merge") {
    return runMerge(cfg, io).match(
      (merged) => concludeMerge(io, merged),
      (problem) => failRun(io, problem),
    );
  }
  const api = overrides?.api ?? new GithubApi({ token: cfg.token, io, apiVersion: cfg.apiVersion });

  if (cfg.kind === "multi") {
    return runMulti(api, cfg, io, uploader).match(
      (targets) => concludeRun(io, { kind: "multi", mode: cfg.mode, targets }),
      (problem) => failRun(io, problem),
    );
  }

  return runSingle(api, cfg, io, uploader).match(
    (target) => concludeRun(io, { kind: "single", mode: cfg.mode, target }),
    (problem) => failRun(io, problem),
  );
}
