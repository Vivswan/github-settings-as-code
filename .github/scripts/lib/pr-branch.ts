/**
 * The push a branch this repository's own scripts write receives (the nightly bump): the bot identity and the lease
 * push. A pull request's fix commits are the platform's autofix module's, not this file's.
 */

import { command, must, STREAMED } from "./command.js";
import { requireEnv } from "./workflow-step.js";

/** Written into the checkout's config, as the workflows did: the runner's checkout dies with the job. */
export function configureBotIdentity(): void {
  must(["git", "config", "user.name", "github-actions[bot]"], STREAMED);
  must(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"], STREAMED);
}

/** HEAD pushed to the PR branch under a lease pinned to the commit the fix was built from, so a concurrent push
 * (even a force-reset to an ancestor) rejects this one instead of racing it. The status is the push's. */
export function leasePush(headRef: string, headSha: string, token: string): number {
  return command(
    [
      "git",
      "push",
      `--force-with-lease=refs/heads/${headRef}:${headSha}`,
      `https://x-access-token:${token}@github.com/${requireEnv("GITHUB_REPOSITORY")}.git`,
      `HEAD:refs/heads/${headRef}`,
    ],
    STREAMED,
  ).status;
}
