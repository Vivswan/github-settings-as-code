/**
 * The commit-back a pull request's branch receives from auto-fix.yml and auto-format.yml: the one place the bot
 * identity and the lease push are spelled, so the two workflows cannot drift apart on either.
 */

import { requireEnv, run, status } from "./workflow-step.js";

/** Written into the checkout's config, as the workflows did: the runner's checkout dies with the job. */
export function configureBotIdentity(): void {
  run(["git", "config", "user.name", "github-actions[bot]"]);
  run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"]);
}

/** HEAD pushed to the PR branch under a lease pinned to the commit the fix was built from, so a concurrent push
 * (even a force-reset to an ancestor) rejects this one instead of racing it. The status is the push's. */
export function leasePush(headRef: string, headSha: string, token: string): number {
  return status([
    "git",
    "push",
    `--force-with-lease=refs/heads/${headRef}:${headSha}`,
    `https://x-access-token:${token}@github.com/${requireEnv("GITHUB_REPOSITORY")}.git`,
    `HEAD:refs/heads/${headRef}`,
  ]);
}
