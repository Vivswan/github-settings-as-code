/**
 * A property of the repo-owned commit-back workflows a later edit breaks with no other check noticing: under the
 * write token, the push jobs execute code from the default branch alone (bun starts there, imports from there, and
 * runs no local action, install, or PR-branch file), the PR branch is a second checkout that only git touches, and
 * the push script gets the lease's inputs (HEAD_SHA, HEAD_REF) from the step's env.
 */

import { describe, expect, test } from "bun:test";
import { type Job, readWorkflow, type Step } from "./workflow-loader.js";

const TRUSTED = "trusted";
const BRANCH = "branch";
const DEFAULT_BRANCH_REF = `\${{ github.event.repository.default_branch }}`;
const HEAD_REF = `\${{ github.event.pull_request.head.ref }}`;
const PR_CHECKOUT = `\${{ github.workspace }}/${BRANCH}`;
const PUSH_SCRIPT = /^bun \.github\/scripts\/[\w-]+-steps\.ts push$/;

/** A runtime or package manager at a command position: each reads the checkout's manifest or scripts and runs
 * what it finds there. */
const RUNS_CHECKOUT = /(?:^|[\s;&|(])(?:bun|bunx|node|npm|npx|pnpm|yarn|deno|tsx)(?=\s|$)/m;
/** The script with its quoted strings blanked, so a word inside an echo is not read as a command. */
const commandsOf = (run: string) => run.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
const label = (step: Step): string => step.name ?? step.uses ?? step.run ?? "unnamed step";
const workingDirectory = (step: Step): unknown =>
  (step as Step & { "working-directory"?: unknown })["working-directory"];

/** Every way a push job breaks the boundary; the assertion and the negative controls read this one list. */
function boundaryProblems(push: Job | undefined): string[] {
  const problems: string[] = [];
  const steps = push?.steps ?? [];
  if (push?.permissions?.contents !== "write") problems.push("the push job has no write token");
  const checkouts = steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout@"));
  const trusted = checkouts.find((step) => step.with?.path === TRUSTED);
  const branch = checkouts.find((step) => step.with?.path === BRANCH);
  if (trusted?.with?.ref !== DEFAULT_BRANCH_REF) {
    problems.push(`the ${TRUSTED} checkout is not the default branch`);
  }
  if (branch?.with?.ref !== HEAD_REF) problems.push(`the ${BRANCH} checkout is not the PR head`);
  for (const step of checkouts) {
    if (step.with?.["persist-credentials"] !== false) {
      problems.push(`the ${String(step.with?.path)} checkout keeps its credentials`);
    }
  }
  const setupBun = steps.find((step) => (step.uses ?? "").startsWith("oven-sh/setup-bun@"));
  if (setupBun?.with?.["bun-version-file"] !== `${TRUSTED}/.bun-version`) {
    problems.push(`bun is not pinned from ${TRUSTED}/.bun-version`);
  }
  let pushes = 0;
  for (const step of steps) {
    if ((step.uses ?? "").startsWith("./")) {
      problems.push(`"${label(step)}" is a local action, run from a checkout`);
    }
    if (step.run === undefined) continue;
    const commands = commandsOf(step.run);
    if (RUNS_CHECKOUT.test(commands) && workingDirectory(step) !== TRUSTED) {
      problems.push(`"${label(step)}" runs checkout code outside ${TRUSTED}`);
    }
    if (/\binstall\b/.test(commands))
      problems.push(`"${label(step)}" installs under the write token`);
    // The raw text: a quoted path is still a path.
    if (new RegExp(`\\b${BRANCH}\\b`).test(step.run)) {
      problems.push(`"${label(step)}" names the ${BRANCH} checkout; only PR_CHECKOUT may`);
    }
    // The one push is leasePush() inside the script; a push written here has no lease the tests exercise.
    if (/\bgit\s+push\b/.test(step.run)) {
      problems.push(`"${label(step)}" pushes outside the push script`);
    }
    // The PR tree's path reaches the push script through its env alone; a run step that reads it would run from it.
    if (/PR_CHECKOUT/.test(step.run)) {
      problems.push(`"${label(step)}" reads PR_CHECKOUT; only the push script may`);
    }
    if (!PUSH_SCRIPT.test(step.run.trim())) continue;
    pushes += 1;
    for (const name of ["HEAD_SHA", "HEAD_REF", "PR_CHECKOUT"]) {
      if (step.env?.[name] === undefined) problems.push(`the push step has no ${name} in its env`);
    }
    if (step.env?.PR_CHECKOUT !== PR_CHECKOUT) problems.push(`PR_CHECKOUT is not ${PR_CHECKOUT}`);
    if (step.env?.HEAD_REF !== HEAD_REF) problems.push(`HEAD_REF is not the PR head`);
  }
  if (pushes !== 1) problems.push(`${pushes} push script steps, not one`);
  return problems;
}

describe("the commit-back push jobs", () => {
  test.each(["auto-fix.yml", "auto-format.yml"])(
    "%s: under the write token only default-branch code runs, the PR branch is git's tree alone, and the push script gets the lease's inputs",
    (file) => {
      expect(boundaryProblems(readWorkflow(file).jobs.push)).toEqual([]);
    },
  );

  const pushStep = (push: Job): Step =>
    (push.steps ?? []).find((step) => PUSH_SCRIPT.test((step.run ?? "").trim())) as Step;
  test.each<[string, (push: Job) => void, RegExp]>([
    [
      "the trusted checkout taken from the PR head",
      (push) => {
        const trusted = (push.steps ?? []).find((step) => step.with?.path === TRUSTED) as Step;
        trusted.with = { ...trusted.with, ref: HEAD_REF };
      },
      /trusted checkout is not the default branch/,
    ],
    [
      "the push script run from the PR branch",
      (push) => {
        (pushStep(push) as Step & { "working-directory"?: string })["working-directory"] = BRANCH;
      },
      /runs checkout code outside trusted/,
    ],
    [
      "a step running a PR-branch file by path",
      (push) => {
        push.steps?.push({
          run: "bun ../branch/postinstall.ts",
          "working-directory": TRUSTED,
        } as Step);
      },
      /names the branch checkout/,
    ],
    [
      "a step running a PR-branch file by a quoted path",
      (push) => {
        push.steps?.push({
          run: 'bun "../branch/postinstall.ts"',
          "working-directory": TRUSTED,
        } as Step);
      },
      /names the branch checkout/,
    ],
    [
      "a step running a PR-branch file through PR_CHECKOUT",
      (push) => {
        push.steps?.push({
          run: 'bun "$PR_CHECKOUT/postinstall.ts"',
          "working-directory": TRUSTED,
          env: { PR_CHECKOUT },
        } as Step);
      },
      /reads PR_CHECKOUT/,
    ],
    [
      "a push written in the workflow beside the script's leased one",
      (push) => {
        push.steps?.push({
          run: "git push --force https://x-access-token:$TOKEN@github.com/$GITHUB_REPOSITORY.git HEAD:refs/heads/$HEAD_REF",
          "working-directory": TRUSTED,
          env: { TOKEN: `\${{ github.token }}`, HEAD_REF },
        } as Step);
      },
      /pushes outside the push script/,
    ],
    [
      "the setup composite action, read from a checkout",
      (push) => {
        push.steps?.push({ uses: "./.github/actions/setup" });
      },
      /is a local action/,
    ],
    [
      "a push step without the lease's head",
      (push) => {
        const step = pushStep(push);
        const { HEAD_SHA: _dropped, ...env } = step.env ?? {};
        step.env = env;
      },
      /no HEAD_SHA in its env/,
    ],
  ])("%s fails the boundary (negative control)", (_case, mutate, message) => {
    for (const file of ["auto-fix.yml", "auto-format.yml"]) {
      const push = structuredClone(readWorkflow(file).jobs.push) as Job;
      mutate(push);
      expect(boundaryProblems(push).join("\n"), file).toMatch(message);
    }
  });
});
