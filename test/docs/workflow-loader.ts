/**
 * One reader for the workflow YAML the docs tests pin, and the parsed shapes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ROOT } from "../root.js";

const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");

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
  env?: Record<string, string>;
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
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}
export function workflowText(file: string): string {
  return readFileSync(join(WORKFLOWS_DIR, file), "utf8");
}

export function readWorkflow(file: string): Workflow {
  return parseYaml(workflowText(file)) as Workflow;
}
