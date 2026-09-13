/**
 * Both nightlies file a failure issue through the fleet's fuzz-issue action, pointing at the artifact the run uploaded, and then dispatch
 * auto-assign.yml with the issue number. The links a rename on one side breaks with no other check noticing: the directory the runner
 * writes, the artifact the issue cites, the condition both run under, and the input names the dispatch passes to a workflow the platform
 * syncs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT } from "../root.js";
import { readWorkflow } from "./workflow-loader.js";

const FUZZ_ISSUE_ACTION = "Vivswan/repo-platform/actions/fuzz-issue@stable";
/** The harness writes every failure's replay bundle under one directory; its name is spelled inline where the dump happens. */
const RUNNER = readFileSync(join(ROOT, "test", "e2e", "runner.ts"), "utf8");

describe.each([
  ["e2e-nightly.yml", "nightly"],
  ["nightly-fuzz.yml", "fuzz"],
])("%s failure path", (file, job) => {
  const steps = readWorkflow(file).jobs[job]?.steps ?? [];

  test("on failure, the filed issue names the artifact the run uploads, from the directory the runner writes", () => {
    const filer = steps.find((s) => s.uses === FUZZ_ISSUE_ACTION && s.with?.mode === "report");
    const upload = steps.find((s) => (s.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(filer, "no reporting fuzz-issue step").toBeDefined();
    expect(upload, "no upload-artifact step").toBeDefined();
    // A step without a condition runs on success() only, so a dropped `if:` files nothing on the night that fails.
    expect(filer?.if).toBe("failure()");
    expect(upload?.if).toBe(filer?.if);
    expect(String(filer?.with?.["artifact-name"])).toBe(String(upload?.with?.name));
    const dir = String(upload?.with?.path).replace(/\/$/, "");
    expect(dir).toBe(String(filer?.with?.["artifacts-dir"]));
    expect(RUNNER, `test/e2e/runner.ts never writes under ${dir}`).toContain(`"${basename(dir)}"`);
  });

  test("every workflow it dispatches declares every input it passes", () => {
    const dispatches = steps.flatMap((s) => [
      ...(s.run ?? "").matchAll(/gh workflow run (\S+\.yml)((?:\s+-f\s+"?[\w-]+=[^\s"]*"?)*)/g),
    ]);
    expect(dispatches.length, "no gh workflow run dispatch").toBeGreaterThan(0);
    for (const [, target = "", flags = ""] of dispatches) {
      const passed = [...flags.matchAll(/-f\s+"?([\w-]+)=/g)].map((m) => m[1] ?? "");
      expect(passed.length, `the ${target} dispatch passes no input`).toBeGreaterThan(0);
      const declared = Object.keys(readWorkflow(target).on.workflow_dispatch?.inputs ?? {});
      expect(
        passed.filter((input) => !declared.includes(input)),
        `${target} declares no workflow_dispatch input for these`,
      ).toEqual([]);
    }
  });
});
