/**
 * The post-green.yml step whose logic outgrew shell: the push probe, which judges the checkout's token before the
 * install and the build spend anything on a commit the job cannot publish.
 *
 *   probe   build job   PAT_SET, GITHUB_OUTPUT   -> proceed=
 *
 * Node builtins only: the probe runs before the job's install.
 */

import { randomBytes } from "node:crypto";
import { attempt, requireEnv, setOutput } from "./lib/workflow-step.js";

/** What each subcommand writes to GITHUB_OUTPUT; test/workflows/post-green-workflow.test.ts judges the job's wiring
 * from it, as it does from the shell steps' echo lines. */
export const STEP_OUTPUTS = { probe: ["proceed"] } as const;

/** A dry-run push asks origin for its receive-pack advertisement over the channel the real push uses, which a token
 * without write access is refused; nothing is created. The target is a ref that never exists, so the dry run judges
 * the token alone: against an existing tag git would refuse the non-fast-forward locally whatever the token. */
const DRY_RUN_PUSH = [
  "git",
  "push",
  "--dry-run",
  "--quiet",
  "origin",
  "HEAD:refs/dry-run/token-probe",
];

/** The text's lines as awk would read them: no trailing record for a final newline, none at all for empty text. */
const linesOf = (text: string): string[] =>
  text === "" ? [] : text.replace(/\n$/, "").split("\n");

/** git's refusal is remote-supplied text, so it is printed inside a stop-commands fence keyed by a per-run token
 * and never inside a workflow command.
 *   the runner acts on any line whose first non-blank text is "::"  -> the fence disarms every such line
 *   only the fence's own token resumes command processing           -> the text can neither forge a command nor swallow the error after it
 */
function printFenced(stderr: string): void {
  const fence = randomBytes(16).toString("hex");
  console.log(`::stop-commands::${fence}`);
  console.log("probe stderr:");
  for (const line of linesOf(stderr)) {
    console.log(`  ${line}`);
  }
  console.log(`::${fence}::`);
}

function probe(): void {
  const push = attempt(DRY_RUN_PUSH);
  if (push.status === 0) {
    setOutput("proceed", "true");
    return;
  }
  if (requireEnv("PAT_SET") === "true") {
    printFenced(push.stderr);
    console.log(
      "::error::REPO_PLATFORM_TOKEN cannot push to this repository; git's refusal is in the probe stderr lines above.",
    );
    process.exit(1);
  }
  console.log(
    [
      "::warning::this run's token cannot push (the caller grants contents: read);",
      "this commit was not packaged and the latest tag was not moved here (the release hook packages each release and moves latest itself).",
      "Raise the caller's ceiling to contents: write, or add a REPO_PLATFORM_TOKEN PAT secret",
      "with Contents (read and write) on this repository, to publish every green push to @latest.",
    ].join(" "),
  );
  setOutput("proceed", "false");
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "probe") {
    probe();
  } else {
    console.error(
      `post-green-steps: unknown command ${JSON.stringify(command ?? null)}; expected probe`,
    );
    process.exit(1);
  }
}
