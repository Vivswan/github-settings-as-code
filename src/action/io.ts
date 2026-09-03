/**
 * The Io implementation over @actions/core: workflow annotations, action
 * outputs, and plain log lines.
 */

import * as core from "@actions/core";
import type { Io } from "../io.js";

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

export function setOutput(name: (typeof OUTPUT_NAMES)[number], value: string): void {
  // Guarded: the runner always sets GITHUB_OUTPUT; local/test runs may not.
  if (process.env.GITHUB_OUTPUT) {
    core.setOutput(name, value);
  }
}

/** The production Io sink: annotations via the runner, logs to stdout. */
export const actionsIo: Io = {
  annotate,
  log: (line) => console.log(line),
  mask: (value) => core.setSecret(value),
};
