import { appendFileSync } from "node:fs";
import * as core from "@actions/core";
import { type Io, maskRegistry, type OutputName } from "../index.js";

/** Generated into the action.yml `outputs` block (bun run build:action-docs); the satisfies clause locks the keys to OutputName. */
export const OUTPUT_DECLS = {
  result: {
    description:
      "The worst result across the run's targets: failed | drift | partial | skipped | applied " +
      "| clean | snapshot | rendered.",
  },
  "skipped-sections": {
    description:
      "Comma-separated sections skipped for missing permissions under on-missing-permission: " +
      "warn, empty when none.",
  },
  "repos-result": {
    description:
      "JSON map of owner/name to {result, source, skipped-sections} for every target of a " +
      "multi-repo run, the empty map {} otherwise.",
  },
} as const satisfies Record<OutputName, { readonly description: string }>;

// The static map keeps the namespace access tree-shakeable (biome noDynamicNamespaceImportAccess) and captures the references at module load, so a spy installed after import is not seen; @actions/core owns the workflow-command escaping (%, CR, LF).
const annotators = { notice: core.notice, warning: core.warning, error: core.error } as const;

export function annotate(level: keyof typeof annotators, message: string): void {
  annotators[level](message);
}

function setOutput(name: OutputName, value: string): void {
  // Guarded: the runner always sets GITHUB_OUTPUT; local/test runs may not.
  if (process.env.GITHUB_OUTPUT) {
    core.setOutput(name, value);
  }
}

function appendSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  appendFileSync(file, `${markdown}\n`);
}

/**
 * `line` as one log line the runner prints and never reads as a workflow command. test/cli/actions.test.ts holds
 * the CLI's log under a runner to the same output.
 *
 *   the runner reads `::` at the start of a line, after leading whitespace -> CR and LF are written %0D and %0A
 *   the runner reads `##[` anywhere in a line                               -> it is written %23%23[
 */
function plainLine(line: string): string {
  return line.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/##\[/g, "%23%23[");
}

export const actionsIo: Io = {
  annotate,
  log: (line) => console.log(plainLine(line)),
  debug: (line) => core.debug(line),
  summary: appendSummary,
  output: setOutput,
  ...maskRegistry(core.setSecret),
};
