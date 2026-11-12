import { appendFileSync } from "node:fs";
import * as core from "@actions/core";
import { type Io, maskRegistry, type OutputName, redactRanges } from "../index.js";

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

/**
 * `::` at the start of a line, after the white space the runner's TrimStart() removes: the 25 characters .NET's
 * Char.IsWhiteSpace accepts (U+0009..U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029,
 * U+202F, U+205F, U+3000).
 */
const LEADING_COMMAND =
  /^([\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*)::/;

/** The masks this action registered with the runner; the log sink redacts them itself before it escapes. */
const registry = maskRegistry(core.setSecret);

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
 * `line` as one log line the runner cannot read as a workflow command, so text from a settings file or from live
 * GitHub state, printed by this action's own writers, cannot issue one. Not covered: what a dependency prints
 * itself, and a writer that bypasses this sink on purpose. test/cli/actions.test.ts holds the CLI to the same output.
 *
 *   the runner reads `::` at the start of a line, after leading whitespace -> CR and LF are written %0D and %0A, a leading `::` %3A%3A
 *   the runner reads `##[` anywhere in a line                               -> it is written %23%23[
 */
function plainLine(line: string): string {
  return line
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(LEADING_COMMAND, "$1%3A%3A")
    .replace(/##\[/g, "%23%23[");
}

export const actionsIo: Io = {
  annotate,
  // Redacted here, before the escapes: the runner masks a registered value only where it stands as registered.
  log: (line) => console.log(plainLine(redactRanges(line, registry.masked()))),
  debug: (line) => core.debug(line),
  summary: appendSummary,
  output: setOutput,
  ...registry,
};
