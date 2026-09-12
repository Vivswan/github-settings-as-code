/**
 * The action's inputs adapter: parseConfig over the runner's inputs and the
 * GITHUB_* context, so run() never touches raw inputs.
 */

import * as core from "@actions/core";
import type { Result } from "neverthrow";
import { type Problem, parseConfig, type RunConfig } from "../index.js";

/** Read and validate every input the step set; the first problem wins. */
export function parseActionConfig(): Result<RunConfig, Problem> {
  // @actions/core reads INPUT_<NAME> (uppercased, spaces to underscores -
  // dashes survive, e.g. `settings-file` -> INPUT_SETTINGS-FILE) and trims.
  return parseConfig((name) => core.getInput(name), process.env);
}
