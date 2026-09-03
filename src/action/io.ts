/**
 * The Io implementation over @actions/core - the only module outside the
 * runner that may import it, so every channel has one production path.
 */

import { appendFileSync } from "node:fs";
import * as core from "@actions/core";
import { type Io, maskRegistry } from "../io.js";

/**
 * Every action output run() writes, with the description the action.yml
 * `outputs` block is generated from (bun run build:action-docs).
 */
export const OUTPUT_DECLS = {
  result: {
    description:
      "applied | partial | clean | drift | failed (worst-of across all targets in multi-repo mode, where skipped can also appear).",
  },
  "skipped-sections": {
    description:
      "Comma-separated sections skipped for missing permissions (deduped union across targets in multi-repo mode).",
  },
  "repos-result": {
    description:
      'Multi-repo mode only: JSON map of owner/name to {result, source, skippedSections}. A redacted private target is keyed by its "private repository #N" placeholder instead of its slug. Empty in single-repo mode.',
  },
} as const satisfies Record<string, { readonly description: string }>;

export type OutputName = keyof typeof OUTPUT_DECLS;

export const OUTPUT_NAMES = Object.keys(OUTPUT_DECLS) as readonly OutputName[];

// @actions/core owns workflow-command escaping (%, CR, LF); the static map
// keeps the namespace access tree-shakeable (biome noDynamicNamespaceImportAccess).
// The references are captured at module load, so a test spying on core.warning
// after import would not be observed here - none does today.
const annotators = { notice: core.notice, warning: core.warning, error: core.error } as const;

export function annotate(level: keyof typeof annotators, message: string): void {
  annotators[level](message);
}

// The root port types `name` as a plain string (it cannot see this layer);
// the declared-name union applies here, at the implementation the port's
// method signature accepts.
function setOutput(name: OutputName, value: string): void {
  // Guarded: the runner always sets GITHUB_OUTPUT; local/test runs may not.
  if (process.env.GITHUB_OUTPUT) {
    core.setOutput(name, value);
  }
}

/** Append one summary block; skipped when GITHUB_STEP_SUMMARY is unset (local/test runs). */
function appendSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) {
    return;
  }
  appendFileSync(file, `${markdown}\n`);
}

/** The production Io sink: annotations and the trace via the runner, logs to stdout. */
export const actionsIo: Io = {
  annotate,
  log: (line) => console.log(line),
  debug: (line) => core.debug(line),
  summary: appendSummary,
  output: setOutput,
  ...maskRegistry(core.setSecret),
};
