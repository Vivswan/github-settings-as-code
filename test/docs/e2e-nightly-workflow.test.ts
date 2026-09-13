/**
 * Both nightlies file through the fleet's nightly issue action and then dispatch auto-assign with the issue number, so
 * assignment policy stays in auto-assign rather than in a filer. One shape, pinned over both workflows.
 */

import { describe, expect, test } from "bun:test";
import { readWorkflow } from "./workflow-loader.js";

const FUZZ_ISSUE_ACTION = "Vivswan/repo-platform/actions/fuzz-issue@stable";

describe.each([
  // The run_attempt suffix: upload-artifact refuses a duplicate name, so a re-run attempt would upload nothing
  // and the filed issue would point at an artifact that never existed.
  ["e2e-nightly.yml", "nightly", "e2e-fuzz", `e2e-artifacts-\${{ github.run_attempt }}`],
  ["nightly-fuzz.yml", "fuzz", "fuzz-nightly", `fuzz-failures-\${{ github.run_attempt }}`],
])("%s issue + auto-assign path", (file, job, label, artifactName) => {
  const wf = readWorkflow(file);
  const steps = wf.jobs[job]?.steps ?? [];
  const filers = steps.filter((s) => s.uses === FUZZ_ISSUE_ACTION);

  test("grants issues: write for the filer and actions: write for the dispatch", () => {
    expect([wf.permissions?.issues, wf.permissions?.actions]).toEqual(["write", "write"]);
  });

  test("files on failure from the artifacts dir and resolves on success, one label, one artifact name", () => {
    const shape = filers.map((s) => ({
      id: s.id,
      if: s.if,
      mode: s.with?.mode,
      label: s.with?.label,
      dir: s.with?.["artifacts-dir"],
      artifact: s.with?.["artifact-name"],
    }));
    expect(shape).toEqual([
      {
        id: "file-issue",
        if: "failure()",
        mode: "report",
        label,
        dir: "test/e2e/.artifacts",
        artifact: artifactName,
      },
      {
        id: undefined,
        if: "success()",
        mode: "resolve",
        label,
        dir: undefined,
        artifact: undefined,
      },
    ]);
    // The upload the issue points at carries the same name the filer names.
    const upload = steps.find((s) => (s.uses ?? "").startsWith("actions/upload-artifact@"));
    expect([upload?.if, upload?.with?.name, upload?.with?.path]).toEqual([
      "failure()",
      artifactName,
      "test/e2e/.artifacts/",
    ]);
  });

  test("dispatches auto-assign.yml with the filed issue number, after filing, on failure", () => {
    const fileIdx = steps.findIndex((s) => s.id === "file-issue");
    const dispatchIdx = steps.findIndex((s) =>
      (s.run ?? "").includes("gh workflow run auto-assign.yml"),
    );
    expect(fileIdx, "no filer step").toBeGreaterThanOrEqual(0);
    expect(dispatchIdx, "no auto-assign dispatch step").toBeGreaterThan(fileIdx);
    const dispatch = steps[dispatchIdx];
    // Gated on a non-empty issue-number, so the dispatch never expands to a bare `-f issue=`.
    expect(dispatch?.if).toBe("failure() && steps.file-issue.outputs.issue-number != ''");
    expect(dispatch?.env?.ISSUE_NUMBER).toBe(`\${{ steps.file-issue.outputs.issue-number }}`);
    // The joined `|| echo "::warning::` shape ties the warning to the failed dispatch; asserting the pieces separately
    // would pass with the warning detached from the fallback branch.
    expect(dispatch?.run).toBe(
      'gh workflow run auto-assign.yml -f "issue=$ISSUE_NUMBER" || echo "::warning::could not dispatch auto-assign.yml"',
    );
  });
});

describe("auto-assign.yml caller forwards the dispatched issue", () => {
  const wf = readWorkflow("auto-assign.yml");

  test("workflow_dispatch declares issue as an optional input and the reusable call forwards it", () => {
    // The nightly filer always passes a number, and a bare dispatch must still run the full sweep.
    expect(wf.on.workflow_dispatch?.inputs?.issue).toMatchObject({ required: false, default: "" });
    expect(String(wf.jobs["auto-assign"]?.with?.issue)).toContain("inputs.issue");
  });
});
