/**
 * Two properties of the repo-owned workflows a later edit breaks with no other check noticing: the commit-back push
 * jobs run no PR code under their write token and push only over the head they patched, and lint:yaml never skips
 * in CI.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../root.js";
import { readWorkflow, SETUP_USES, type Step } from "./workflow-loader.js";

const SCRIPTS = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;
/** A bun invocation the shell would run: the word `bun` at a command position. */
const RUNS_BUN = /(?:^|[\s;&|(])bun(?=\s|$)/m;
/** A step that runs code from the checkout: a run step invoking bun, or a local composite (each of ours runs bun). */
const runsCheckoutCode = (step: Step) =>
  RUNS_BUN.test(step.run ?? "") || (step.uses !== SETUP_USES && (step.uses ?? "").startsWith("./"));

describe("the commit-back push jobs", () => {
  test.each(["auto-fix.yml", "auto-format.yml"])(
    "%s: no PR code runs under the write token, and the push is leased to the patched head",
    (file) => {
      const push = readWorkflow(file).jobs.push;
      expect(push?.permissions?.contents).toBe("write");
      expect((push?.steps ?? []).filter(runsCheckoutCode)).toEqual([]);
      // A plain --force would overwrite a commit that landed after the patch was cut; the lease names the sha the job verified.
      const pushes = (push?.steps ?? []).filter((step) => /\bgit push\b/.test(step.run ?? ""));
      expect(pushes.length, `${file} has no git push step`).toBe(1);
      const [step] = pushes;
      expect(step?.env?.HEAD_SHA).toBeDefined();
      expect(step?.run).toContain(`--force-with-lease="refs/heads/\${HEAD_REF}:\${HEAD_SHA}"`);
      expect(step?.run).not.toMatch(/\bgit push\b(?![^\n]*--force-with-lease)/);
      // --force beside the lease defeats it (git overrides the stale check), and -f is its short form.
      expect(step?.run).not.toMatch(/--force(?!-with-lease)|\s-f(?=\s)/);
    },
  );
});

describe("lint:yaml", () => {
  /** The script's exit status from the repository root with PATH cut to the system directories, where yamllint is absent. */
  function lintYamlWithout(env: Record<string, string>): number {
    try {
      execFileSync("bash", ["-c", SCRIPTS["lint:yaml"] ?? ""], {
        cwd: ROOT,
        stdio: "pipe",
        env: { HOME: process.env.HOME ?? "", ...env, PATH: "/usr/bin:/bin" },
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  }

  test("without yamllint a CI run fails and a local run skips", () => {
    expect(lintYamlWithout({ CI: "true" })).toBe(1);
    expect(lintYamlWithout({})).toBe(0);
  });
});
