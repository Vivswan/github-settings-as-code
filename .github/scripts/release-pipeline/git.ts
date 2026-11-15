/**
 * The git the release pipeline runs: one name per failure shape its callers judge (a thrown refusal, a plain "no",
 * null, or the refusal as a value), the identity the pipeline's own commits carry, and the reads every section
 * shares: ancestry, a commit's position on main, the manifest's version. Bun and Node builtins only: bun runs this
 * before `bun install`.
 */

import { command, commandFailure, must } from "../lib/command.js";

const MANIFEST_FILE = ".release-please-manifest.json";

export const FULL_SHA = /^[0-9a-f]{40}$/;

export function git(cwd: string, ...args: string[]): string {
  return gitWithEnv(cwd, {}, ...args);
}

export function gitWithEnv(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return must(["git", ...args], { cwd, env, stderr: "log-and-capture" }).stdout.trim();
}

/** git's stdout, or null when it exited 1 (a "no" from --verify, --is-ancestor, and the like); any other failure
 * is thrown, so a repository git cannot read never passes for one without the object. */
function gitOrNo(cwd: string, ...args: string[]): string | null {
  const ran = command(["git", ...args], { cwd });
  if (ran.status === 1) {
    return null;
  }
  if (ran.status !== 0) {
    throw commandFailure(["git", ...args], ran);
  }
  return ran.stdout.trim();
}

/** git's stdout, or null on any failure: for reads whose absence git reports with exit 128 (a missing path). */
export function tryGit(cwd: string, ...args: string[]): string | null {
  const ran = command(["git", ...args], { cwd, stderr: "discard" });
  return ran.status === 0 ? ran.stdout.trim() : null;
}

/** A push as git ran it. A refusal is never read from git's words: the caller re-reads origin. A ref that moved
 * since it was observed is a lost compare-and-set to retry, an unmoved one a refusal to throw; a refused deletion
 * whose refs are all gone is done. */
export function push(cwd: string, ...pushArgs: string[]): Error | null {
  const argv = ["git", "push", ...pushArgs];
  const ran = command(argv, { cwd, stderr: "log-and-capture" });
  return ran.status === 0 ? null : commandFailure(argv, ran);
}

/** Passed per invocation: written into a checkout's config it would outlive the run and stamp every later commit made from that repository, or any worktree sharing it. */
export const BOT_IDENTITY = {
  GIT_AUTHOR_NAME: "settings-as-code-release",
  GIT_AUTHOR_EMAIL: "settings-as-code-release@users.noreply.github.com",
  GIT_COMMITTER_NAME: "settings-as-code-release",
  GIT_COMMITTER_EMAIL: "settings-as-code-release@users.noreply.github.com",
};

/** Verdicts on a truncated history do not hold; the jobs check out with fetch-depth 0. */
export function assertFullHistory(cwd: string, what: string, consequence: string): void {
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      `${what} needs the full history (fetch-depth: 0) and this checkout is shallow: ${consequence}`,
    );
  }
}

/** merge-base fails outright on a sha this checkout lacks, so unknown ones are screened into a plain "no" first. */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return (
    [ancestor, descendant].every((sha) => resolveCommit(cwd, sha) !== null) &&
    gitOrNo(cwd, "merge-base", "--is-ancestor", ancestor, descendant) !== null
  );
}

/** The commit a name resolves to, or null for none (a sha the checkout lacks, or a short one naming several objects). */
function resolveCommit(cwd: string, name: string): string | null {
  return gitOrNo(cwd, "rev-parse", "--verify", "--quiet", `${name}^{commit}`);
}

/** The manifest's version at a commit: what release-please last released, or is about to. */
export function manifestVersionAt(cwd: string, treeish: string): string {
  const manifest = JSON.parse(git(cwd, "show", `${treeish}:${MANIFEST_FILE}`)) as Record<
    string,
    unknown
  >;
  return String(manifest["."]);
}

/** The commits reachable from `sourceSha` along first parents: one more per merge to main, whatever a merged PR's
 * branch held. Refused on a shallow checkout, which would count to its boundary and name a build tag by a truncated count. */
export function mainCount(cwd: string, sourceSha: string): number {
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      "a build tag's position needs the full history (fetch-depth: 0) and this checkout is shallow: the count of commits under the source would stop at the shallow boundary.",
    );
  }
  return Number(git(cwd, "rev-list", "--count", "--first-parent", sourceSha));
}
