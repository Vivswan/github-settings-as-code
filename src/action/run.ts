import {
  executeRun,
  failRun,
  GitHubApi,
  type GitHubClient,
  type Io,
  type RunDeps,
} from "../index.js";
import { actionsArtifactUploader } from "./artifact.js";
import { parseActionConfig } from "./inputs.js";
import { actionsIo } from "./io.js";

/** `overrides` exists for tests (a stub client, a capturing Io, a capturing uploader). */
export async function run(overrides?: {
  api?: GitHubClient;
  io?: Io;
  uploader?: RunDeps["uploader"];
}): Promise<number> {
  const io = overrides?.io ?? actionsIo;
  const deps: RunDeps = {
    io,
    createClient: (token, io, apiVersion) =>
      overrides?.api ?? new GitHubApi({ token, io, apiVersion }),
    uploader: overrides?.uploader ?? actionsArtifactUploader,
  };
  return parseActionConfig().match(
    async (cfg) => (await executeRun(cfg, deps)).exitCode,
    async (problem) => failRun(io, problem),
  );
}
