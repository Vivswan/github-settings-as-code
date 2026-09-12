/**
 * The action's run: parse the inputs, run the single, multi, or merge flow, conclude. The policies live with the
 * engine (src/engine/orchestrate.ts).
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
import { parseActionConfig } from "./inputs.js";
import { actionsIo } from "./io.js";

/** `overrides` exists for tests (a stub client, a capturing Io, a capturing uploader). */
export async function run(overrides?: {
  api?: GithubClient;
  io?: Io;
  uploader?: ArtifactUploader;
}): Promise<number> {
  const io = overrides?.io ?? actionsIo;
  const uploader = overrides?.uploader ?? actionsArtifactUploader;

  const parsed = parseActionConfig();
  if (parsed.isErr()) {
    return failRun(io, parsed.error);
  }
  const cfg = parsed.value;

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
