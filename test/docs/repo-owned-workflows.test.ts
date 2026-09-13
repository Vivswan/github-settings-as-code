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
import { readWorkflow, type Step } from "./workflow-loader.js";

const SCRIPTS = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;
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
      // A plain --force would overwrite a commit that landed after the patch was cut; the lease names the sha the job verified.
      // Every push line of the job is judged (a second, unleased push beside the leased one is a write the lease does not cover),
      // as words with continuations joined and shell quotes removed, as git receives them.
      const pushLines = (push?.steps ?? []).flatMap((step) =>
        (step.run ?? "")
          .replace(/\\\n/g, " ")
          .split("\n")
          .filter((line) => /\bgit\s+push\b/.test(line))
          .map((line) => ({
            step,
            // Quotes removed and `${NAME}` written `$NAME`: the word as git receives it, whichever spelling the script used.
            words: line
              .split(/[\s;&|()]+/)
              .map((w) => w.replace(/["']/g, "").replace(/\$\{(\w+)\}/g, "$$$1")),
          })),
      );
      expect(pushLines.length, `${file} has no git push`).toBeGreaterThan(0);
      for (const { step, words } of pushLines) {
        expect(
          step.env?.HEAD_SHA,
          `${file}: a push step without HEAD_SHA in its env`,
        ).toBeDefined();
        // Git honors the first lease word, so an earlier, looser lease would override this one; exactly one, and it is this one.
        expect(words.filter((word) => word.startsWith("--force-with-lease"))).toEqual([
          "--force-with-lease=refs/heads/$HEAD_REF:$HEAD_SHA",
        ]);
        // A forced update hides in a short-option cluster (-vf, -f4), a +refspec, or a --no-force-with-lease that cancels the lease.
        const forced = words.filter(
          (word) =>
            /^-[^-]*f/.test(word) ||
            /^--(?:no-)?force(?!-with-lease=|-if-includes$)/.test(word) ||
            word.startsWith("+"),
        );
        expect(forced).toEqual([]);
      }
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
