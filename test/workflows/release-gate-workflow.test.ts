// tier: pr
/**
 * release-gate.yml against the contract its managed caller holds it to: ci.yml (the platform's file, synced, not
 * edited here) calls it on the release PR with nothing passed and a contents: read ceiling, and GitHub rejects a
 * mismatch only there, on the first run the caller makes. The convention's other half is ours: nightly.yml is the
 * one repository-side caller (one definition, two callers), and no other repo-owned workflow calls it, since a
 * second call runs the tier twice beside ci.yml's.
 */

import { describe, expect, test } from "bun:test";
import { type Job, readWorkflow, type Workflow, workflowFiles } from "./workflow-loader.js";

const RELEASE_GATE = "release-gate.yml";
const CALL = `./.github/workflows/${RELEASE_GATE}`;

/** The contract as a list of what breaks it, so one assertion and the negative controls read the same judgment. */
function contractProblems(wf: Workflow): string[] {
  const problems: string[] = [];
  const triggers = Object.keys(wf.on);
  if (triggers.join() !== "workflow_call")
    problems.push(`triggers ${triggers.join(", ")}, not workflow_call alone`);
  const call = wf.on.workflow_call;
  if (call?.inputs !== undefined)
    problems.push(`declares inputs: ${Object.keys(call.inputs).join(", ")}`);
  if (call?.secrets !== undefined)
    problems.push(`declares secrets: ${Object.keys(call.secrets).join(", ")}`);
  for (const [name, job] of Object.entries(wf.jobs)) {
    // A job without a bound runs for GitHub's six-hour default; the callers count a cancel as red, six hours late.
    if (typeof job["timeout-minutes"] !== "number")
      problems.push(`job ${name} has no timeout-minutes`);
    // `none` narrows; only a scope above the caller's contents: read is a grant GitHub rejects at call time.
    const grants = Object.entries({ ...wf.permissions, ...job.permissions }).filter(
      ([scope, level]) => level !== "none" && !(scope === "contents" && level === "read"),
    );
    if (grants.length > 0) {
      problems.push(
        `job ${name} asks beyond contents: read: ${grants.map(([s, l]) => `${s}: ${l}`).join(", ")}`,
      );
    }
  }
  return problems;
}

/** Every calling job, as file#job: a second call in the same file runs the tier twice as surely as one in checks.yml. */
const callingJobs = (files: ReadonlyArray<[string, Workflow]>): string[] =>
  files.flatMap(([file, wf]) =>
    Object.entries(wf.jobs)
      .filter(([, job]: [string, Job]) => job.uses === CALL)
      .map(([name]) => `${file}#${name}`),
  );

describe(RELEASE_GATE, () => {
  const workflow = readWorkflow(RELEASE_GATE);

  test("holds the managed caller's contract: workflow_call alone, nothing passed, bounded jobs under contents: read", () => {
    expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0);
    expect(contractProblems(workflow)).toEqual([]);
  });

  test.each<[string, (wf: Workflow) => void, RegExp]>([
    [
      "a dispatch trigger beside the call",
      (wf) => {
        wf.on.workflow_dispatch = null;
      },
      /not workflow_call alone/,
    ],
    [
      "a required input",
      (wf) => {
        wf.on.workflow_call = { inputs: { seed: { required: true } } };
      },
      /declares inputs: seed/,
    ],
    [
      "a job without a bound",
      (wf) => {
        delete wf.jobs.fuzz?.["timeout-minutes"];
      },
      /fuzz has no timeout-minutes/,
    ],
    [
      "a job asking for issues: write",
      (wf) => {
        (wf.jobs.fuzz as Job).permissions = { issues: "write" };
      },
      /asks beyond contents: read: issues: write/,
    ],
  ])("%s breaks the contract (negative control)", (_case, mutate, failure) => {
    const mutated = structuredClone(workflow);
    mutate(mutated);
    expect(contractProblems(mutated).join("\n")).toMatch(failure);
  });

  test("a job narrowing a scope to none stays within the ceiling", () => {
    const narrowed = structuredClone(workflow);
    (narrowed.jobs.fuzz as Job).permissions = { issues: "none" };
    expect(contractProblems(narrowed)).toEqual([]);
  });

  test("one repo-owned calling job, in nightly.yml; ci.yml's call is the platform's", () => {
    const repoOwned = workflowFiles()
      .filter((file) => file !== "ci.yml")
      .map((file): [string, Workflow] => [file, readWorkflow(file)]);
    const calls = callingJobs(repoOwned);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.startsWith("nightly.yml#")).toBe(true);
  });

  test("a second call in nightly.yml or one in checks.yml is a double run (negative control)", () => {
    const nightly = structuredClone(readWorkflow("nightly.yml"));
    nightly.jobs.again = { uses: CALL };
    expect(callingJobs([["nightly.yml", nightly]])).toHaveLength(2);
    const checks = structuredClone(readWorkflow("checks.yml"));
    checks.jobs.gate = { uses: CALL };
    expect(
      callingJobs([
        ["checks.yml", checks],
        ["nightly.yml", readWorkflow("nightly.yml")],
      ]),
    ).toHaveLength(2);
  });
});
