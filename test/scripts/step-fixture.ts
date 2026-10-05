/**
 * Runs a workflow step script under this bun as the workflow does, with a GITHUB_OUTPUT file of its own: stdout,
 * stderr, status, and the outputs the step wrote, as they were. Synchronous, so the release fixture's push plans
 * (which wrap a synchronous body) apply to the step's pushes too.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface StepResult {
  stdout: string;
  stderr: string;
  status: number;
  /** The GITHUB_OUTPUT file's lines. */
  outputs: string[];
}

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
