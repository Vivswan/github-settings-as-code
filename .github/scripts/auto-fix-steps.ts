/**
 * The two auto-fix.yml steps whose logic outgrew shell: the build job's rebuild, which regenerates the generated
 * files and cuts the fix patch, and the push job's commit-back of that patch. One subcommand per step:
 *
 *   rebuild   build job   RUNNER_TEMP, GITHUB_OUTPUT                  -> autofix.patch, changed=, pruned=
 *   push      push job    TOKEN, CAN_RETRIGGER, HEAD_REF, HEAD_SHA,    -> the commit on the PR branch, notify=
 *                         PRUNED, RUNNER_TEMP, GITHUB_REPOSITORY,
 *                         GITHUB_OUTPUT
 *
 * FIX_OWNED_PATHS is a security boundary and stays literal here: the patch is cut on a runner PR code ran on, so
 * the push job admits nothing outside it, and it runs this file from the default branch's checkout, so the list it
 * enforces is main's. test/scripts/auto-fix-steps.test.ts pins the list and GENERATORS to the
 * generated-output table (.github/scripts/generated.ts), so a newly registered output cannot slip past either step.
 *
 * Node builtins only: the push job installs nothing, so no git hook or lifecycle script exists where the write
 * token is.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "./lib/entry.js";
import { configureBotIdentity, leasePush } from "./lib/pr-branch.js";
import { capture, requireEnv, run, setOutput, status } from "./lib/workflow-step.js";

/** In generated.ts table order: the later generators import the descriptor-derived files and the gaps index
 * through src/, and the inputs table reads action.yml, so each source renders first. */
export const GENERATORS = [
  "build:openapi",
  "build:gaps-index",
  "build:docs",
  "build:action-docs",
  "build:inputs-table",
] as const;

/** The whole files the src/ generators write, spelled out: a directory entry would admit a file no generator registers. */
const GENERATED_FILES = [
  "src/generated/spec-roles.ts",
  "src/generated/spec-rules.ts",
  "src/generated/upstream-gaps.ts",
] as const;

export const GAPS_DIR = "src/upstream-gaps/";

/** A `dir/` entry covers everything under it, deletions included (a graduated gap file is a deletion). */
export const FIX_OWNED_PATHS = [
  "README.md",
  "action.yml",
  "docs/reference/coverage.md",
  "docs/reference/undeclared-policy.md",
  "docs/reference/permissions.md",
  "docs/operate/check-mode.md",
  "docs/reference/sections.md",
  "docs/reference/inputs.md",
  "docs/reference/architecture.md",
  "docs/start/getting-started.md",
  ...GENERATED_FILES,
  GAPS_DIR,
] as const;

export function fixOwned(path: string): boolean {
  return FIX_OWNED_PATHS.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : entry === path,
  );
}

/** The refusal names every admitted path, so a red push job's log shows the boundary without this file. */
function outsideFixOwned(path: string): string {
  const files = FIX_OWNED_PATHS.filter((entry) => !entry.endsWith("/"));
  const dirs = FIX_OWNED_PATHS.filter((entry) => entry.endsWith("/"));
  return `::error::the fix patch staged '${path}', outside the generated docs (${files.join(", ")}), and ${dirs.join(", ")}; refusing to push`;
}

/** `git diff --cached --quiet` answers with its status: 0 for no change, 1 for one; anything else is git failing. */
function stagedChange(...pathspec: string[]): boolean {
  const code = status(["git", "diff", "--cached", "--quiet", ...pathspec]);
  if (code !== 0 && code !== 1) {
    process.exit(code);
  }
  return code === 1;
}

function rebuild(): void {
  for (const generator of GENERATORS) {
    run(["bun", "run", generator]);
  }
  // Anything the earlier steps left staged is not this workflow's fix: start from an empty index so the patch
  // holds exactly the fix-owned paths.
  run(["git", "reset", "-q"]);
  run(["git", "add", "-A", "--", ...FIX_OWNED_PATHS]);
  const patch = join(requireEnv("RUNNER_TEMP"), "autofix.patch");
  run(["git", "diff", "--cached", "--binary"], { stdoutFile: patch });
  if (statSync(patch).size === 0) {
    console.log("docs and upstream gaps already fresh");
    setOutput("changed", "false");
    setOutput("pruned", "false");
    return;
  }
  run(["git", "diff", "--cached", "--stat"]);
  setOutput("changed", "true");
  // A patch touching a gap file means gap files graduated (the index alone is a regeneration); the push job picks
  // the commit subject from this.
  setOutput("pruned", String(stagedChange("--", GAPS_DIR)));
}

function push(): number | undefined {
  // bun has already read its bunfig.toml and .env from the trusted checkout it started in; only git runs in the
  // PR branch's tree from here on, with main's environment and no hook or config of that branch.
  process.chdir(requireEnv("PR_CHECKOUT"));
  const token = requireEnv("TOKEN");
  const canRetrigger = requireEnv("CAN_RETRIGGER");
  const headRef = requireEnv("HEAD_REF");
  const headSha = requireEnv("HEAD_SHA");
  const pruned = requireEnv("PRUNED");
  // The branch can move between the build and this push (a Dependabot rebase): the patch belongs to HEAD_SHA
  // only, and the newer head's own run owns the rebuild.
  const superseded = (): boolean => {
    // A failed refresh leaves origin/HEAD_REF where it was, and that stale read answers: the shell ran this fetch
    // inside an if condition, where a failure does not end the step either.
    status(["git", "fetch", "--quiet", "origin", headRef]);
    return capture(["git", "rev-parse", `origin/${headRef}`]) !== headSha;
  };
  if (capture(["git", "rev-parse", "HEAD"]) !== headSha) {
    console.log("::notice::head moved since the build; skipping the stale fix push");
    return;
  }
  run([
    "git",
    "apply",
    "--index",
    "--binary",
    join(requireEnv("RUNNER_TEMP"), "autofix", "autofix.patch"),
  ]);
  // --no-renames lists a staged rename as its delete and add halves, so a rename OUT of a protected path cannot
  // hide behind an allowed destination.
  const staged = capture(["git", "diff", "--cached", "--no-renames", "--name-only", "-z"])
    .split("\0")
    .filter((path) => path !== "");
  for (const path of staged) {
    if (!fixOwned(path)) {
      console.log(outsideFixOwned(path));
      return 1;
    }
  }
  if (!stagedChange()) {
    console.log("the fix patch stages nothing against the head commit; nothing to push");
    return;
  }
  configureBotIdentity();
  let subject = "build: regenerate generated files";
  if (!stagedChange("--", GAPS_DIR, ...GENERATED_FILES)) {
    subject = "docs: regenerate generated docs";
  }
  if (pruned === "true") {
    subject = "fix: graduate upstream gaps octokit now ships";
  }
  // [dependabot skip] keeps Dependabot rebasing and updating the PR over this commit; without it Dependabot stops
  // touching a PR once someone else pushes to it.
  run(["git", "commit", "--no-verify", "-m", subject, "-m", "[dependabot skip]"]);
  if (leasePush(headRef, headSha, token) !== 0) {
    if (superseded()) {
      console.log("::notice::head moved during the push; skipping the stale fix push");
      return;
    }
    return 1;
  }
  if (canRetrigger === "true") {
    return;
  }
  // The fix landed via github.token, which starts no workflows, so the PR's checks will not re-run on the new
  // head: surface that here and, through notify=, on the PR.
  setOutput("notify", "true");
  console.log(
    "::warning::auto-fix pushed without REPO_PLATFORM_TOKEN - checks will not re-run on the new head; close/reopen the PR or register the token",
  );
}

if (import.meta.main) {
  await dispatch("auto-fix-steps", { rebuild, push }, process.argv.slice(2));
}
