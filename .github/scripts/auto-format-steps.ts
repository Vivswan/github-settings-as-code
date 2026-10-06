/**
 * The two auto-format.yml steps: the format job's run of the formatter, cut into a patch for the push job, and
 * that job's commit of the patch to the PR branch under a lease on the commit it was cut on.
 *
 *   format   format job   RUNNER_TEMP, GITHUB_OUTPUT                                   -> format.patch, head=, changed=
 *   push     push job     GH_TOKEN, HEAD_REF, HEAD_SHA, RUNNER_TEMP, GITHUB_REPOSITORY   -> the commit on the PR branch
 *
 * Node builtins only: the push job installs nothing, so no git hook or lifecycle script exists where the write
 * token is.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { configureBotIdentity, leasePush } from "./lib/pr-branch.js";
import { capture, requireEnv, run, setOutput } from "./lib/workflow-step.js";

function format(): void {
  // The patch belongs to this commit alone; the push job refuses any other head.
  setOutput("head", capture(["git", "rev-parse", "HEAD"]));
  run(["bun", "run", "lint:fix"]);
  // Anything the formatter left staged is not this workflow's fix: start from an empty index, then stage
  // modifications and deletions of tracked files alone (a formatter adds nothing).
  run(["git", "reset", "-q"]);
  run(["git", "add", "-u"]);
  const patch = join(requireEnv("RUNNER_TEMP"), "format.patch");
  run(["git", "diff", "--cached", "--binary"], { stdoutFile: patch });
  if (statSync(patch).size === 0) {
    console.log("nothing to format");
    setOutput("changed", "false");
    return;
  }
  run(["git", "diff", "--cached", "--stat"]);
  setOutput("changed", "true");
}

function push(): void {
  // bun has already read its bunfig.toml and .env from the trusted checkout it started in; only git runs in the
  // PR branch's tree from here on, with main's environment and no hook or config of that branch.
  process.chdir(requireEnv("PR_CHECKOUT"));
  const token = requireEnv("GH_TOKEN");
  const headRef = requireEnv("HEAD_REF");
  const headSha = requireEnv("HEAD_SHA");
  // The branch can move between the two jobs; the patch was cut on HEAD_SHA and formats that tree alone, so a
  // newer head gets its own run (re-apply the label) instead of a commit formatting the old one.
  if (capture(["git", "rev-parse", "HEAD"]) !== headSha) {
    console.log("::notice::head moved since the format; skipping the stale formatting push");
    return;
  }
  run([
    "git",
    "apply",
    "--index",
    "--binary",
    join(requireEnv("RUNNER_TEMP"), "format", "format.patch"),
  ]);
  configureBotIdentity();
  run(["git", "commit", "--no-verify", "-m", "style: apply automated formatting"]);
  const pushed = leasePush(headRef, headSha, token);
  if (pushed !== 0) {
    process.exit(pushed);
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "format") {
    format();
  } else if (command === "push") {
    push();
  } else {
    console.error(
      `auto-format-steps: unknown command ${JSON.stringify(command ?? null)}; expected format | push`,
    );
    process.exit(1);
  }
}
