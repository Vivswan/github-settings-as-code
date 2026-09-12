/**
 * One run executor behind the action and the CLI: a parsed RunConfig runs to its exit code, with the outputs and the
 * summary through `deps.io`. The two faces differ only in what they hand in, so the arm dispatch cannot drift.
 */

import type { GithubClient } from "../github/api.js";
import type { Io } from "../io.js";
import type { Problem } from "../problem.js";
import type { ArtifactUploader } from "../report/artifact-report.js";
import { concludeMerge, concludeRun, failRun } from "./deliver.js";
import type { RunConfig } from "./inputs.js";
import { runMerge } from "./merge.js";
import { runMulti } from "./multi.js";
import { runSingle } from "./single.js";
import { concludeSnapshot, runSnapshot } from "./snapshot.js";

/** What a face hands the executor; the config carries everything else. */
export interface RunDeps {
  readonly io: Io;
  /** Opens the client a config's token authorizes; a merge never asks for one. */
  readonly createClient: (token: string, io: Io, apiVersion: string) => GithubClient;
  /** The artifact channel's uploader: only the Actions runner has one, and without it that channel fails before any API call. */
  readonly uploader?: ArtifactUploader;
  /** Words a fatal problem for the face; the action's wording unless the face words a remedy differently. */
  readonly describe?: (problem: Problem) => string;
}

export function executeRun(cfg: RunConfig, deps: RunDeps): Promise<number> {
  const { io } = deps;
  const fail = (problem: Problem): number => failRun(io, problem, deps.describe);
  if (cfg.kind === "merge") {
    return Promise.resolve(runMerge(cfg, io).match((merged) => concludeMerge(io, merged), fail));
  }
  const api = deps.createClient(cfg.token, io, cfg.apiVersion);
  switch (cfg.kind) {
    case "snapshot":
      return runSnapshot(api, cfg, io).match((finished) => concludeSnapshot(io, finished), fail);
    case "multi":
      return runMulti(api, cfg, io, deps.uploader).match(
        (targets) => concludeRun(io, { kind: "multi", mode: cfg.mode, targets }),
        fail,
      );
    case "single":
      return runSingle(api, cfg, io, deps.uploader).match(
        (target) => concludeRun(io, { kind: "single", mode: cfg.mode, target }),
        fail,
      );
  }
}
