/**
 * The runner as the CLI's second face: a gsac step under GitHub Actions speaks
 * the runner's workflow commands and files, so the runner sees what the action
 * step gives it. Written without @actions/core, which the CLI does not carry;
 * test/cli/actions.test.ts pins every form against the action's Io.
 */

import { randomUUID } from "node:crypto";
import { EOL } from "node:os";
import type { AnnotationLevel, OutputName } from "../index.js";

export interface ActionsRunner {
  /** GITHUB_OUTPUT; the runner always sets it, so an unset one only drops the record, as the action's Io does. */
  readonly outputFile: string | undefined;
  /** GITHUB_STEP_SUMMARY; `--summary <file>` takes precedence over it. */
  readonly summaryFile: string | undefined;
}

/** The runner's files as it sets them; an empty value is unset, as @actions/core reads it. */
function runnerFile(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** The runner the process reports to: one when GITHUB_ACTIONS is "true", none for a terminal. */
export function actionsRunner(
  env: Readonly<Record<string, string | undefined>>,
): ActionsRunner | undefined {
  if (env.GITHUB_ACTIONS !== "true") {
    return undefined;
  }
  return {
    outputFile: runnerFile(env.GITHUB_OUTPUT),
    summaryFile: runnerFile(env.GITHUB_STEP_SUMMARY),
  };
}

/** One `::name::message` line with the runner's data escaping (%, CR, LF), as @actions/core issues it. */
export function workflowCommand(name: "add-mask" | AnnotationLevel, message: string): string {
  const data = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::${name}::${data}${EOL}`;
}

/** One GITHUB_OUTPUT record in the heredoc form the runner reads, with the fresh delimiter @actions/core mints per record. */
export function outputRecord(name: OutputName, value: string): string {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  return `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`;
}
