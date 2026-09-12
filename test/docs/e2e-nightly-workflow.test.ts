/**
 * On failure the nightly files an issue and then dispatches auto-assign with that issue's number, so assignment policy stays in auto-assign rather
 * than the filer.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");

interface Step {
  name?: string;
  id?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, { steps?: Step[]; with?: Record<string, unknown> }>;
}

describe("e2e-nightly.yml issue + auto-assign path", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "e2e-nightly.yml"), "utf8"),
  ) as Workflow;
  const steps = wf.jobs.nightly?.steps ?? [];

  test("grants actions: write for the workflow dispatch", () => {
    expect(wf.permissions?.actions).toBe("write");
  });

  test("the filer step has an id so the dispatch can read its issue-number output", () => {
    const filer = steps.find((s) => (s.run ?? "").includes("file-fuzz-issue.ts"));
    expect(filer?.id).toBe("file-issue");
  });

  test("dispatches auto-assign.yml with the filed issue number, after filing, on failure", () => {
    const fileIdx = steps.findIndex((s) => (s.run ?? "").includes("file-fuzz-issue.ts"));
    const dispatchIdx = steps.findIndex((s) =>
      (s.run ?? "").includes("gh workflow run auto-assign.yml"),
    );
    expect(fileIdx, "no file-fuzz-issue step").toBeGreaterThanOrEqual(0);
    expect(dispatchIdx, "no auto-assign dispatch step").toBeGreaterThan(fileIdx);
    const dispatch = steps[dispatchIdx];
    // Gated on a non-empty issue-number, so the dispatch never expands to a bare `-f issue=`.
    expect(dispatch?.if).toContain("failure()");
    expect(dispatch?.if).toContain("steps.file-issue.outputs.issue-number != ''");
    expect(dispatch?.env?.ISSUE_NUMBER).toContain("steps.file-issue.outputs.issue-number");
    expect(dispatch?.run).toContain('-f "issue=$ISSUE_NUMBER"');
    expect(dispatch?.run).not.toContain("steps.file-issue.outputs");
  });

  test("tolerates a dispatch failure as a warning, not a job failure", () => {
    const dispatch = steps.find((s) => (s.run ?? "").includes("gh workflow run auto-assign.yml"));
    // The joined `|| echo "::warning::` shape ties the warning to the failed dispatch; asserting the pieces separately would pass with the warning
    // detached from the fallback branch.
    expect(dispatch?.run).toContain('|| echo "::warning::');
  });
});

describe("auto-assign.yml caller forwards the dispatched issue", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "auto-assign.yml"), "utf8"),
  ) as Workflow;

  test("workflow_dispatch declares issue as an optional input and the reusable call forwards it", () => {
    const dispatch = wf.on?.workflow_dispatch as
      | { inputs?: Record<string, { required?: boolean; default?: unknown }> }
      | undefined;
    // The nightly filer always passes a number, and a bare dispatch must still run the full sweep.
    expect(dispatch?.inputs?.issue).toMatchObject({ required: false, default: "" });
    expect(String(wf.jobs["auto-assign"]?.with?.issue)).toContain("inputs.issue");
  });
});
