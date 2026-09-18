/**
 * A property of the repo-owned commit-back workflows a later edit breaks with no other check noticing: the push jobs
 * run no PR code under their write token and push only over the head they patched.
 */

import { describe, expect, test } from "bun:test";
import { readWorkflow, type Step } from "./workflow-loader.js";

/** A runtime or package manager at a command position: each reads the checkout's manifest or scripts and runs what it finds there. */
const RUNS_CHECKOUT = /(?:^|[\s;&|(])(?:bun|bunx|node|npm|npx|pnpm|yarn|deno|tsx)(?=\s|$)/m;
/** The script with its quoted strings blanked, so a word inside an echo is not read as a command. */
const commandsOf = (run: string) => run.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
/** A step that runs code from the checkout: a run step invoking a runtime, or any local action (its action.yml is PR-editable). */
const runsCheckoutCode = (step: Step) =>
  RUNS_CHECKOUT.test(commandsOf(step.run ?? "")) || (step.uses ?? "").startsWith("./");

describe("the commit-back push jobs", () => {
  test.each(["auto-fix.yml", "auto-format.yml"])(
    "%s: no PR code runs under the write token, and the push is leased to the patched head",
    (file) => {
      const push = readWorkflow(file).jobs.push;
      expect(push?.permissions?.contents).toBe("write");
      expect((push?.steps ?? []).filter(runsCheckoutCode)).toEqual([]);
      // The lease names the sha the job verified and guards one ref, so a push under the write token is exactly: that lease as its only
      // option, one https remote, and that ref as its only destination. Every push command of every step is judged.
      const pushes = (push?.steps ?? []).flatMap((step) =>
        [...(step.run ?? "").replace(/\\\n/g, " ").matchAll(/\bgit\s+push\b[^;&|()\n]*/g)].map(
          (m) => ({
            step,
            words: m[0]
              .split(/\s+/)
              .slice(2)
              .map((w) => w.replace(/["']/g, "").replace(/\$\{(\w+)\}/g, "$$$1")),
          }),
        ),
      );
      expect(pushes.length, `${file} has no git push`).toBeGreaterThan(0);
      for (const { step, words } of pushes) {
        expect(
          step.env?.HEAD_SHA,
          `${file}: a push step without HEAD_SHA in its env`,
        ).toBeDefined();
        expect(words.filter((word) => word.startsWith("-"))).toEqual([
          "--force-with-lease=refs/heads/$HEAD_REF:$HEAD_SHA",
        ]);
        const operands = words.filter((word) => !word.startsWith("-"));
        expect(operands[0], "the remote is not a URL").toMatch(/^https:\/\//);
        expect(operands.slice(1)).toEqual(["HEAD:refs/heads/$HEAD_REF"]);
      }
    },
  );
});
