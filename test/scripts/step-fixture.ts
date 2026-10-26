/**
 * Runs a workflow step script under this bun as the workflow does, with a GITHUB_OUTPUT file of its own: stdout,
 * stderr, status, and the outputs the step wrote, as they were. Synchronous, so the release fixture's push plans
 * (which wrap a synchronous body) apply to the step's pushes too.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";

/** What one step run produced; `outputs` is the GITHUB_OUTPUT file's lines. */
export interface StepResult {
  stdout: string;
  stderr: string;
  status: number;
  outputs: string[];
}

/** Git as a runner sees it: GIT_AUTHOR_* and GIT_COMMITTER_* outrank the config configureBotIdentity writes (a developer shell exporting them would sign the bot's commits as the developer), and no global or system config is read. */
const AMBIENT_GIT_CLEARED: Record<string, string | undefined> = {
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_AUTHOR_DATE: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined,
  GIT_COMMITTER_DATE: undefined,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};

export function runStep(
  script: string,
  cwd: string,
  runnerTemp: string,
  env: Record<string, string | undefined>,
  ...args: string[]
): StepResult {
  const path = join(import.meta.dir, "..", "..", ".github", "scripts", `${script}.ts`);
  mkdirSync(runnerTemp, { recursive: true });
  const outputFile = join(runnerTemp, "github-output");
  rmSync(outputFile, { force: true });
  const result = Bun.spawnSync([process.execPath, path, ...args], {
    cwd,
    env: Object.fromEntries(
      Object.entries({
        ...process.env,
        ...AMBIENT_GIT_CLEARED,
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: outputFile,
        ...env,
      }).filter(([, value]) => value !== undefined),
    ) as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    status: result.exitCode,
    outputs: existsSync(outputFile)
      ? readFileSync(outputFile, "utf8").split("\n").filter(Boolean)
      : [],
  };
}
