/**
 * The git the release pipeline runs: one spawn per helper, each with the failure shape its callers judge (a thrown
 * refusal, a plain "no", or null), the identity the pipeline's own commits carry, and the reads every section
 * shares: ancestry, a commit's position on main, the manifest's version. Node builtins only: bun runs this before
 * `bun install`.
 */

import { execFileSync } from "node:child_process";

const MANIFEST_FILE = ".release-please-manifest.json";

export const FULL_SHA = /^[0-9a-f]{40}$/;

export function git(cwd: string, ...args: string[]): string {
  return gitWithEnv(cwd, {}, ...args);
}

export function gitWithEnv(cwd: string, env: Record<string, string>, ...args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
    }).trim();
  } catch (error) {
    throw gitFailure(args, error);
  }
}

function gitFailure(args: string[], error: unknown): Error {
  const stderr = (error as { stderr?: unknown }).stderr;
  const detail = typeof stderr === "string" && stderr.trim() !== "" ? `: ${stderr.trim()}` : "";
  return new Error(`git ${args.join(" ")} failed${detail}`);
}

/** git's stdout, or null when it exited 1 (a "no" from --verify, --is-ancestor, and the like); any other failure
 * is thrown, so a repository git cannot read never passes for one without the object. */
export function gitOrNo(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) {
      return null;
    }
    throw gitFailure(args, error);
  }
}

/** git's stdout, or null on any failure: for reads whose absence git reports with exit 128 (a missing path). */
export function tryGit(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** A push as git ran it. A refusal is never read from git's words: the caller re-reads origin, and a ref that
 * moved since it was observed is a lost compare-and-set to retry, an unmoved one a refusal to throw. */
export function push(cwd: string, ...pushArgs: string[]): Error | null {
  try {
    execFileSync("git", ["push", ...pushArgs], { cwd, encoding: "utf8" });
    return null;
  } catch (error) {
    return gitFailure(["push", ...pushArgs], error);
  }
}

/** The identity the pipeline's own commits carry, passed per invocation: written into a checkout's config it would
 * outlive the run and stamp every later commit made from that repository, or any worktree sharing it. */
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
export function resolveCommit(cwd: string, name: string): string | null {
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

export interface MainPosition {
  /** Commits reachable from it along first parents: one more per merge to main, whatever a merged PR's branch held. */
  count: number;
  /** Its committer date in UTC, YYYYMMDD. */
  date: string;
}

/** Refused on a shallow checkout: it would count to its boundary and mint a truncated count, so the version would
 * sort below ones minted from the full history for older commits. */
export function mainPosition(cwd: string, sourceSha: string): MainPosition {
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      "the pre-release version needs the full history (fetch-depth: 0) and this checkout is shallow: the count of commits under the source would stop at the shallow boundary.",
    );
  }
  const count = Number(git(cwd, "rev-list", "--count", "--first-parent", sourceSha));
  const committed = Number(git(cwd, "show", "-s", "--format=%ct", sourceSha));
  const date = new Date(committed * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  return { count, date };
}
