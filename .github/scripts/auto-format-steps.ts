/**
 * The auto-format.yml push step: the formatting patch the format job cut on HEAD_SHA, committed and pushed to the
 * PR branch under a lease on that commit.
 *
 *   push   push job   GH_TOKEN, HEAD_REF, HEAD_SHA, RUNNER_TEMP, GITHUB_REPOSITORY   -> the commit on the PR branch
 *
 * Node builtins only: the push job installs nothing, so no git hook or lifecycle script exists where the write
 * token is.
 */

import { join } from "node:path";
import { configureBotIdentity, leasePush } from "./lib/pr-branch.js";
import { capture, requireEnv, run } from "./lib/workflow-step.js";

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
  if (command === "push") {
    push();
  } else {
    console.error(
      `auto-format-steps: unknown command ${JSON.stringify(command ?? null)}; expected push`,
    );
    process.exit(1);
  }
}
