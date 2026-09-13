/**
 * One reader for the workflow and composite-action YAML the docs tests pin: the file list split by header, the parsed
 * shapes, and the step predicates around the setup composite every repo-owned job goes through.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ROOT } from "../root.js";

const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
/** The setup composite (bun, the locked install, yamllint on request), as a job's `uses:` spells it. */
export const SETUP_USES = "./.github/actions/setup";
/** A leading comment block naming the platform sync: such a file is overwritten on every sync, every other is repo-owned. */
const MANAGED = /^(?:\s*#.*\n)*?\s*#.*managed by Vivswan\/repo-platform/;

export interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Concurrency {
  group?: string;
  queue?: string;
  "cancel-in-progress"?: boolean | string;
}
/** A job: steps on a runner, or (`uses`) a call of a reusable workflow. */
export interface Job {
  if?: string;
  needs?: string | string[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  concurrency?: Concurrency;
  steps?: Step[];
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
}
interface Trigger {
  inputs?: Record<string, { required?: boolean; type?: string; default?: unknown }>;
  secrets?: Record<string, { required?: boolean }>;
  [key: string]: unknown;
}
export interface Workflow {
  on: Record<string, Trigger | null>;
  permissions?: Record<string, string>;
  concurrency?: Concurrency;
  jobs: Record<string, Job>;
}
export interface CompositeAction {
  runs: { using?: string; steps?: Step[] };
}

export function workflowText(file: string): string {
  return readFileSync(join(WORKFLOWS_DIR, file), "utf8");
}

export function readWorkflow(file: string): Workflow {
  return parseYaml(workflowText(file)) as Workflow;
}

/** `dir` is relative to the repository root, e.g. `.github/actions/setup`. */
export function readAction(dir: string): CompositeAction {
  return parseYaml(readFileSync(join(ROOT, dir, "action.yml"), "utf8")) as CompositeAction;
}

export function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort();
}

export function repoOwnedWorkflowFiles(): string[] {
  return workflowFiles().filter((file) => !MANAGED.test(workflowText(file)));
}

/** The run scalar's lines with every heredoc body (`<<TAG` through its terminator) removed: what the shell executes. */
export function executedLines(run: string): string[] {
  const lines: string[] = [];
  let terminator: string | undefined;
  for (const line of run.split("\n")) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) {
        terminator = undefined;
      }
      continue;
    }
    lines.push(line);
    terminator = line
      .match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/)
      ?.slice(1)
      .find(Boolean);
  }
  return lines;
}

/** A `bun install` the job relies on: `|| true` masks the failure, so a line carrying `||` is not one. */
export function installs(run: string | undefined): boolean {
  return executedLines(run ?? "").some(
    (line) => /^\s*bun install(?:\s|$)/.test(line) && !line.includes("||"),
  );
}

/**
 * A setup input as the runner compares it: lower-cased, since GitHub compares expression strings without regard to
 * letter case. An expression (`${{ ... }}`) has no value here, so it is undefined and satisfies neither predicate.
 */
function setupInput(step: Step, name: string, fallback: string): string | undefined {
  const raw = String(step.with?.[name] ?? fallback);
  return raw.includes("${{") ? undefined : raw.toLowerCase();
}

/** The setup composite step when it installs: any literal `install` input but "false" does. */
export function setupInstalls(step: Step): boolean {
  const install = setupInput(step, "install", "true");
  return step.uses === SETUP_USES && install !== undefined && install !== "false";
}

export function setupYamllint(step: Step): boolean {
  return step.uses === SETUP_USES && setupInput(step, "yamllint", "false") === "true";
}
