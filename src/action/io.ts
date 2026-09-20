import { appendFileSync } from "node:fs";
import * as core from "@actions/core";
import { type Io, maskRegistry, type OutputName } from "../index.js";

/** Generated into the action.yml `outputs` block (bun run build:action-docs); the satisfies clause locks the keys to OutputName. */
export const OUTPUT_DECLS = {
  result: {
    description:
      "The worst result across the run's targets: failed | drift | partial | skipped | applied | clean | snapshot | rendered " +
      "(drift and clean in mode: check, applied in apply, snapshot in mode: snapshot, rendered in mode: render; skipped only " +
      "across a fleet). Exit 1 exactly when it is failed, or drift in mode: check.",
  },
  "skipped-sections": {
    description:
      "Comma-separated sections skipped for missing permissions under on-missing-permission: warn (deduped union " +
      "across targets in multi-repo mode); empty when none.",
  },
  "repos-result": {
    description:
      "JSON map of owner/name to {result, source, skipped-sections} for every target of a multi-repo run (repos, " +
      'repos-dir, or the snapshot-dir form of mode: snapshot). A redacted private target is keyed by its "private ' +
      'repository #N" placeholder instead of its slug. The empty map {} for a run over one repository or a render.',
  },
} as const satisfies Record<OutputName, { readonly description: string }>;

// @actions/core owns workflow-command escaping (%, CR, LF). The static map keeps the namespace access tree-shakeable
// (biome noDynamicNamespaceImportAccess); the references are captured at module load, so a spy installed after import is not seen.
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

export const actionsIo: Io = {
  annotate,
  log: (line) => console.log(line),
  debug: (line) => core.debug(line),
  summary: appendSummary,
  output: setOutput,
  ...maskRegistry(core.setSecret),
};
