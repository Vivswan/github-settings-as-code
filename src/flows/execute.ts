/**
 * One run executor behind the action and the CLI: a parsed RunConfig runs to its end, with the outputs and the
 * summary through `deps.io`. The two faces differ only in what they hand in, so the arm dispatch cannot drift.
 */

import type { GitHubClient } from "../github/api.js";
import type { Io } from "../io.js";
import type { Problem } from "../problem.js";
import type { ArtifactUploader } from "../report/artifact-report.js";
import { concludeRender, concludeRun, failRun } from "./deliver.js";
import type { RunConfig } from "./inputs.js";
import { runMulti } from "./multi.js";
import { runRender } from "./render.js";
import { runSingle } from "./single.js";
import { concludeSnapshot, runSnapshot } from "./snapshot.js";

/** What a face hands the executor; the config carries everything else. */
export interface RunDeps {
  readonly io: Io;
  /** Opens the client a config's token authorizes; a merge never asks for one. */
  readonly createClient: (token: string, io: Io, apiVersion: string) => GitHubClient;
  /** The artifact channel's uploader; parseConfig refuses that channel for a face that declares no upload capability. */
  readonly uploader?: ArtifactUploader;
}

/**
 * How a run ended: its exit code, and the problem it ended in when it never reached a target (the outputs and the
 * error line are already through `deps.io`; the command line's --json envelope carries the problem's text beside them).
 */
export interface RunEnd {
  readonly exitCode: number;
  readonly fatal?: Problem;
}

export function executeRun(cfg: RunConfig, deps: RunDeps): Promise<RunEnd> {
  const { io } = deps;
  const fail = (problem: Problem): RunEnd => ({ exitCode: failRun(io, problem), fatal: problem });
  const end = (exitCode: number): RunEnd => ({ exitCode });
  if (cfg.kind === "render") {
    return Promise.resolve(
      runRender(cfg, io).match((merged) => end(concludeRender(io, merged)), fail),
    );
  }
  const api = deps.createClient(cfg.token, io, cfg.apiVersion);
  switch (cfg.kind) {
    case "snapshot":
      return runSnapshot(api, cfg, io).match(
        (finished) => end(concludeSnapshot(io, finished)),
        fail,
      );
    case "multi":
      return runMulti(api, cfg, io, deps.uploader).match(
        (targets) => end(concludeRun(io, { kind: "multi", mode: cfg.mode, targets })),
        fail,
      );
    case "single":
      return runSingle(api, cfg, io, deps.uploader).match(
        (target) => end(concludeRun(io, { kind: "single", mode: cfg.mode, target })),
        fail,
      );
  }
}
