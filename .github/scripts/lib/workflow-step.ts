/**
 * What a workflow `run:` step's bash gave the scripts that replaced it, so a moved step keeps its exit codes and
 * outputs: `set -e` (a failing command ends the step with that command's status), `$(...)`, a variable the step
 * cannot run without, and the `>> "$GITHUB_OUTPUT"` append. Node builtins only: a push job runs these before any
 * install.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { constants } from "node:os";

export interface RunOptions {
  env?: Record<string, string>;
  /** stdout goes to this file instead of the step's log, as `> file` would; `stderrToo` sends stderr there as well. */
  stdoutFile?: string;
  stderrToo?: boolean;
}

/** The variable's value; unset or empty ends the step naming it, as `${NAME:?}` would. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`${name} must be set for this step`);
    process.exit(1);
  }
  return value;
}

export function setOutput(name: string, value: string): void {
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `${name}=${value}\n`);
}

/** The status bash would report: the exit code, or 128 plus the signal number for a child a signal ended. A command
 * that cannot start ends the step, as bash's 127 would. */
function statusOf(command: string, result: SpawnSyncReturns<unknown>): number {
  if (result.error !== undefined) {
    console.error(`${command}: ${result.error.message}`);
    process.exit(127);
  }
  if (result.signal !== null) {
    return 128 + (constants.signals[result.signal] ?? 0);
  }
  return result.status ?? 1;
}

/** The command's exit status, its output on the step's log unless redirected: for a command whose status is the
 * answer (`git diff --quiet`, a push under a lease). */
export function status(argv: readonly string[], options: RunOptions = {}): number {
  const [command = "", ...args] = argv;
  const fd = options.stdoutFile === undefined ? null : openSync(options.stdoutFile, "w");
  try {
    const result = spawnSync(command, args, {
      stdio: ["inherit", fd ?? "inherit", fd !== null && options.stderrToo ? fd : "inherit"],
      env: { ...process.env, ...options.env },
    });
    return statusOf(command, result);
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

/** Runs the command; a failure ends the step with the command's status, as `set -e` does. */
export function run(argv: readonly string[], options: RunOptions = {}): void {
  const code = status(argv, options);
  if (code !== 0) {
    process.exit(code);
  }
}

/** The command's stdout with its trailing newlines removed, as `$(...)` yields it; stderr stays on the step's log,
 * and a failure ends the step with the command's status. Unbounded like `$(...)`: a staged-path listing or a diff
 * can pass spawnSync's 1 MiB default. */
export function capture(argv: readonly string[], options: Pick<RunOptions, "env"> = {}): string {
  const [command = "", ...args] = argv;
  const result = spawnSync(command, args, {
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: Number.MAX_SAFE_INTEGER,
  });
  const code = statusOf(command, result);
  if (code !== 0) {
    process.exit(code);
  }
  return result.stdout.replace(/\n+$/, "");
}
