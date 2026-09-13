import * as core from "@actions/core";
import type { Result } from "neverthrow";
import { type Problem, parseConfig, type RunConfig } from "../index.js";

export function parseActionConfig(): Result<RunConfig, Problem> {
  // @actions/core reads INPUT_<NAME> (uppercased, spaces to underscores, dashes kept: `settings-file` -> INPUT_SETTINGS-FILE) and trims.
  // The runner has the Actions artifact service, so the artifact report channel is admitted here alone.
  return parseConfig((name) => core.getInput(name), process.env, { artifactUpload: true });
}
