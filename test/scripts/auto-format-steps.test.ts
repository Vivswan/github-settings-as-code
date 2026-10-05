/**
 * auto-format.yml's push step against local fixture repositories: the branches the workflow text cannot show,
 * which checkout the patch is committed on, under whose identity, and what a moved branch does to the push.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  clone,
  commitAll,
  type Fixture,
  git,
  installReleasePipelineFixture,
  seedFixture,
  write,
} from "./release-pipeline-fixture.js";
import { runStep } from "./step-fixture.js";

setDefaultTimeout(60_000);
installReleasePipelineFixture();

const REMOTE_URL = "https://x-access-token:t0ken@github.com/o/r.git";

/** The push job's checkout of a same-repo PR branch, with the format job's patch downloaded beside it. */
function prFixture(): { fx: Fixture; pr: string; headSha: string; temp: string } {
  const fx = seedFixture();
  const pr = clone(fx.root, fx.origin, "pr");
  write(pr, "src/marker.ts", "export const marker=1\n");
  const headSha = commitAll(pr, "feat: a pull request");
  git(pr, "push", "--quiet", "origin", "HEAD:refs/heads/pr");
  git(pr, "checkout", "--quiet", "-b", "pr");
  git(pr, "config", `url.${fx.origin}.insteadOf`, REMOTE_URL);
  const temp = join(fx.root, "runner-temp");
  write(pr, "src/marker.ts", "export const marker = 1;\n");
  git(pr, "add", "-u");
  write(
    join(temp, "format"),
    "format.patch",
    execFileSync("git", ["diff", "--cached", "--binary"], { cwd: pr, encoding: "utf8" }),
  );
  git(pr, "reset", "--hard", "--quiet");
  return { fx, pr, headSha, temp };
}

/** Run from outside the PR clone, as the push job runs it from the trusted checkout. */
const push = (pr: string, temp: string, headSha: string) =>
  runStep(
    "auto-format-steps",
    temp,
    temp,
    {
      GH_TOKEN: "t0ken",
      HEAD_REF: "pr",
      HEAD_SHA: headSha,
      GITHUB_REPOSITORY: "o/r",
      PR_CHECKOUT: pr,
    },
    "push",
  );

const originTip = (fx: Fixture): string => git(fx.origin, "rev-parse", "refs/heads/pr");

describe("push", () => {
  test("the patch lands on the PR branch as the bot's formatting commit over the head it was cut on", () => {
    const { fx, pr, headSha, temp } = prFixture();
    const result = push(pr, temp, headSha);
    expect(result).toMatchObject({ status: 0, outputs: [] });
    expect(result.stdout).not.toContain("::");
    const tip = originTip(fx);
    expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(headSha);
    expect(git(fx.origin, "log", "-1", "--format=%B%n%an <%ae>", tip)).toBe(
      "style: apply automated formatting\n\ngithub-actions[bot] <github-actions[bot]@users.noreply.github.com>",
    );
    expect(git(fx.origin, "show", `${tip}:src/marker.ts`)).toBe("export const marker = 1;");
  });

  test("a checkout that is not the head the patch was cut on pushes nothing, with a notice", () => {
    const { fx, pr, headSha, temp } = prFixture();
    const result = push(pr, temp, fx.mergeSha);
    expect(result).toEqual({
      status: 0,
      stdout: "::notice::head moved since the format; skipping the stale formatting push\n",
      stderr: "",
      outputs: [],
    });
    expect(originTip(fx)).toBe(headSha);
    expect(git(pr, "status", "--porcelain")).toBe("");
  });

  test("a branch that moved after the patch was cut rejects the lease push, and the step fails with git's status", () => {
    const { fx, pr, headSha, temp } = prFixture();
    const rival = clone(fx.root, fx.origin, "rival");
    git(rival, "checkout", "--quiet", "pr");
    write(rival, "src/other.ts", "export const other = 1;\n");
    const rivalSha = commitAll(rival, "feat: the rival push");
    git(rival, "push", "--quiet", "origin", "HEAD:refs/heads/pr");
    const result = push(pr, temp, headSha);
    expect(result).toMatchObject({ status: 1, outputs: [] });
    expect(result.stderr).toContain("[rejected]");
    expect(originTip(fx)).toBe(rivalSha);
  });
});
