/**
 * Both nightlies file a failure issue through the fleet's fuzz-issue action, pointing at the artifact the run uploaded, resolve it on the
 * next green night, and dispatch auto-assign.yml with the issue number. The links a rename on one side breaks with no other check noticing:
 * the directory the runner writes, the artifact the issue cites, the conditions the steps run under, the step ids the expressions read, the
 * label the report and the resolve share, and the input names the dispatch passes to a workflow the platform syncs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../root.js";
import { readWorkflow, type Step } from "./workflow-loader.js";

const FUZZ_ISSUE_ACTION = "Vivswan/repo-platform/actions/fuzz-issue@stable";
/** The harness writes every failure's replay bundle under one directory, spelled as path segments where the dump happens. */
const RUNNER = readFileSync(join(ROOT, "test", "e2e", "runner.ts"), "utf8");

const NIGHTLIES: ReadonlyArray<[file: string, job: string]> = [
  ["e2e-nightly.yml", "nightly"],
  ["nightly-fuzz.yml", "fuzz"],
];

const filerIn = (steps: Step[], mode: string) =>
  steps.find((s) => s.uses === FUZZ_ISSUE_ACTION && s.with?.mode === mode);

describe.each(NIGHTLIES)("%s failure path", (file, job) => {
  const steps = readWorkflow(file).jobs[job]?.steps ?? [];
  const report = filerIn(steps, "report");
  const resolve = filerIn(steps, "resolve");

  test("on failure, the filed issue names the artifact the run uploads, from the directory the runner writes", () => {
    const upload = steps.find((s) => (s.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(report, "no reporting fuzz-issue step").toBeDefined();
    expect(upload, "no upload-artifact step").toBeDefined();
    // A step without a condition runs on success() only, so a dropped `if:` files nothing on the night that fails.
    expect(report?.if).toBe("failure()");
    expect(upload?.if).toBe(report?.if);
    expect(String(report?.with?.["artifact-name"])).toBe(String(upload?.with?.name));
    const dir = String(upload?.with?.path).replace(/\/$/, "");
    expect(dir).toBe(String(report?.with?.["artifacts-dir"]));
    // The runner joins the directory from ROOT and quoted segments; the workflow's path must be exactly those segments, in order.
    const segments = dir
      .split("/")
      .map((segment) => JSON.stringify(segment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    expect(RUNNER, `test/e2e/runner.ts never joins ${dir} under ROOT`).toMatch(
      new RegExp(`join\\(\\s*ROOT\\s*,\\s*${segments.join("\\s*,\\s*")}\\s*,\\s*\``),
    );
  });

  test("on success, the resolve step closes the label the report step files under", () => {
    expect(resolve, "no resolving fuzz-issue step").toBeDefined();
    expect(resolve?.if).toBe("success()");
    expect(String(resolve?.with?.label)).toBe(String(report?.with?.label));
  });

  test("every steps.<id> the job's expressions read names a step of the job", () => {
    const ids = new Set(steps.map((s) => s.id).filter((id) => id !== undefined));
    const read = steps.flatMap((s) =>
      [
        s.if ?? "",
        ...Object.values(s.env ?? {}),
        ...Object.values(s.with ?? {}).map(String),
      ].flatMap((text) => [...text.matchAll(/\bsteps\.([\w-]+)\./g)].map((m) => m[1] ?? "")),
    );
    // The dispatch is gated on the filer's output, so a zero here means the walk went blind, not that the job reads nothing.
    expect(read.length).toBeGreaterThan(0);
    expect(
      read.filter((id) => !ids.has(id)),
      `${file}#${job} reads steps that do not exist`,
    ).toEqual([]);
  });

  test("every workflow it dispatches declares every input it passes", () => {
    // The dispatch command runs to the next shell separator, so every -f on it is read, wherever the other options sit.
    const dispatches = steps.flatMap((s) => [
      ...(s.run ?? "").matchAll(/gh workflow run (\S+\.yml)([^;&|\n]*)/g),
    ]);
    expect(dispatches.length, "no gh workflow run dispatch").toBeGreaterThan(0);
    for (const [, target = "", rest = ""] of dispatches) {
      const passed = [
        ...rest.matchAll(/(?:^|\s)(?:-f|--raw-field|-F|--field)[\s=]+"?([\w-]+)=/g),
      ].map((m) => m[1] ?? "");
      expect(passed.length, `the ${target} dispatch passes no input`).toBeGreaterThan(0);
      const declared = Object.keys(readWorkflow(target).on.workflow_dispatch?.inputs ?? {});
      expect(
        passed.filter((input) => !declared.includes(input)),
        `${target} declares no workflow_dispatch input for these`,
      ).toEqual([]);
    }
  });
});

test("the nightlies file under distinct labels, so one's green night cannot close the other's issue", () => {
  const labels = NIGHTLIES.map(
    ([file, job]) => filerIn(readWorkflow(file).jobs[job]?.steps ?? [], "report")?.with?.label,
  );
  // GitHub compares label names without regard to case.
  expect(new Set(labels.map((label) => String(label).toLowerCase())).size).toBe(labels.length);
});
