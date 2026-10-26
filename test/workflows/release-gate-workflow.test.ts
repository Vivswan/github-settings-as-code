/**
 * The two properties of release-gate.yml nothing else reports. GitHub rejects a required input, a required secret, or a grant
 * above the caller's ceiling at call time, and actionlint covers the syntax; the sync never revalidates the file
 * (class starter, seeded once). What stays silent:
 *   a job without timeout-minutes  -> runs for GitHub's six-hour default on the release PR
 *   a second repository-side call  -> the gate runs twice, beside ci.yml's own call, with no error anywhere
 */

import { describe, expect, test } from "bun:test";
import { type Job, readWorkflow, type Workflow, workflowFiles } from "./workflow-loader.js";

/** The reusable gate workflow. */
const RELEASE_GATE = "release-gate.yml";

/** How a caller's job names it under `uses`. */
const CALL = `./.github/workflows/${RELEASE_GATE}`;

/** The jobs of `wf` with no timeout-minutes. */
const unboundedJobs = (wf: Workflow): string[] =>
  Object.entries(wf.jobs)
    .filter(([, job]) => typeof job["timeout-minutes"] !== "number")
    .map(([name]) => name);

/** Every calling job, as file#job: a second call in the same file runs the gate twice as surely as one in checks.yml. */
const callingJobs = (files: ReadonlyArray<[string, Workflow]>): string[] =>
  files.flatMap(([file, wf]) =>
    Object.entries(wf.jobs)
      .filter(([, job]: [string, Job]) => job.uses === CALL)
      .map(([name]) => `${file}#${name}`),
  );

describe(RELEASE_GATE, () => {
  const workflow = readWorkflow(RELEASE_GATE);

  test("every job is bounded", () => {
    expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0);
    expect(unboundedJobs(workflow)).toEqual([]);
    const mutated = structuredClone(workflow);
    delete mutated.jobs.fuzz?.["timeout-minutes"];
    expect(unboundedJobs(mutated), "negative control").toEqual(["fuzz"]);
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
