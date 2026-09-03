/**
 * The Io implementation over @actions/core - the only module outside the
 * runner that may import it, so every channel has one production path.
 */

import { appendFileSync } from "node:fs";
import * as core from "@actions/core";
import { type Io, maskRegistry, type OutputName } from "../io.js";

/**
 * The description of every action output, generated into the action.yml
 * `outputs` block (bun run build:action-docs). The satisfies clause locks the
 * keys to OutputName: a missing or phantom output fails to compile here.
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
} as const satisfies Record<OutputName, { readonly description: string }>;

// @actions/core owns workflow-command escaping (%, CR, LF); the static map
// keeps the namespace access tree-shakeable (biome noDynamicNamespaceImportAccess).
// The references are captured at module load, so a test spying on core.warning
// after import would not be observed here - none does today.
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
