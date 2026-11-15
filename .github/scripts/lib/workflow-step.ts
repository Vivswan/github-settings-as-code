/**
 * What a workflow `run:` step's bash gave the scripts that replaced it, besides its commands (lib/command.ts): a
 * variable the step cannot run without, and the `>> "$GITHUB_OUTPUT"` append. Node builtins only: a push job runs
 * these before any install.
 */

import { appendFileSync } from "node:fs";

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
