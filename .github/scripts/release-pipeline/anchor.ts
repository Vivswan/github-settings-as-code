/**
 * release-please's boundary: last-release-sha in release-please-config.json, anchored inside the release PR branch
 * so the squash merge lands it on main. The release PR is held to the commit its notes were built from, main to the
 * cycle its newest release merge closed. The config is read once here and refused when malformed, never repaired.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertFullHistory,
  BOT_IDENTITY,
  FULL_SHA,
  git,
  gitWithEnv,
  isAncestor,
  push,
  tryGit,
} from "./git.js";

/** release-please's config at the checkout root, the file the boundary is read from and written into. */
const CONFIG_FILE = "release-please-config.json";

/** A squash-merged release-please PR's subject on main, anchored at both ends wherever release merges are recognized: a prefix match would let "chore(main): release pipeline documentation" impersonate one and park the boundary check. */
const RELEASE_SUBJECT = /^chore\(main\): release (\d+\.\d+\.\d+)(?: \(#\d+\))?$/;

/** checks.yml's head_ref conditions spell this by hand; test/workflows/checks-workflow.test.ts pins them to it. */
export const RELEASE_PR_BRANCH_PREFIX = "release-please--";

/** release-please's branch for main's release PR. */
const RELEASE_PR_BRANCH = `${RELEASE_PR_BRANCH_PREFIX}branches--main`;

/** Main as a full-history checkout of the release PR's head holds it. */
const MAIN = "origin/main";

/** The repair of a release PR branch whose base cannot be read: release-please builds a new one once this one is gone. */
const REBUILD = `Delete the branch, and the next green push to main has release-please rebuild the release PR and the hook anchor it:\n  git push origin --delete ${RELEASE_PR_BRANCH}`;

/** release-please's config with the one key this pipeline reads and writes; the rest is release-please's. */
type ReleaseConfig = Record<string, unknown> & { "last-release-sha"?: string };

/** The config's text; a missing file is refused naming it, any other read failure is thrown as it came. */
function readConfigText(cwd: string): string {
  try {
    return readFileSync(join(cwd, CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      throw error;
    }
    throw new Error(
      `${CONFIG_FILE} is missing from ${cwd}; the release pipeline reads release-please's boundary (last-release-sha) from it. Restore it by PR.`,
    );
  }
}

/** What a JSON value that is no object holds, as the refusal names it. */
function jsonKind(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    return "an array";
  }
  if (parsed === null) {
    return "null";
  }
  return `a ${typeof parsed}`;
}

/** The config's JSON as an object; anything else is refused naming the file. */
function parseConfigObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it by PR.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE} holds ${jsonKind(parsed)}, not a JSON object; fix it by PR.`);
  }
  return parsed as Record<string, unknown>;
}

/** The config as the checkout holds it. The file is the user's and release-please's, so nothing here is repaired: a
 * missing or malformed one, or a boundary that is no commit sha, is refused naming the file (an absent boundary is
 * the pre-first-release state and passes). */
function readReleaseConfig(cwd: string): ReleaseConfig {
  const config = parseConfigObject(readConfigText(cwd));
  const boundary = config["last-release-sha"];
  if (boundary !== undefined && (typeof boundary !== "string" || !FULL_SHA.test(boundary))) {
    throw new Error(
      `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(boundary)}, not a 40-hex commit sha; fix it by PR.`,
    );
  }
  return config as ReleaseConfig;
}

export interface AnchorOptions {
  /** The checkout the release PR branch is fetched into and the anchor commit made in. */
  cwd: string;

  /** The main commit this run judged; the branch is anchored only when release-please built it on this commit. */
  sourceSha: string;

  /** How many pushes a release-please refresh may overtake before the run gives up; 3 by default. */
  attempts?: number;
}

export interface AnchorResult {
  changed: boolean;
  reason: string;
}

/** The newest release commit `git log` lists for `revs` (HEAD when none), or "" for none. The grep only narrows (it
 * matches any message line with the prefix); RELEASE_SUBJECT decides, so "chore(main): release pipeline documentation"
 * can neither become the boundary nor hide the real newest release commit. */
function newestRelease(cwd: string, ...revs: string[]): string {
  const listed = git(cwd, "log", "--grep", "^chore(main): release ", "--format=%H%x09%s", ...revs);
  for (const line of listed.split("\n")) {
    const [sha, subject] = line.split("\t");
    if (sha !== undefined && subject !== undefined && RELEASE_SUBJECT.test(subject)) {
      return sha;
    }
  }
  return "";
}

/** The commit a release PR branch is built on: the first parent of the newest release commit on the branch's
 * first-parent chain above `main`. The bound matters: a walk into main's own history would read main's last release
 * merge on a branch that holds no release commit. */
function releaseBase(cwd: string, main: string, branch: string): string {
  const release = newestRelease(cwd, "--first-parent", `${main}..${branch}`);
  if (release === "") {
    throw new Error(
      `the release PR branch holds no release commit ("chore(main): release X.Y.Z") on its first-parent chain above ${main}, ` +
        "so the commit its notes were built from cannot be read: main was merged in with the branch as the second parent, " +
        `or release-please did not build this branch.\n${REBUILD}`,
    );
  }
  return git(cwd, "rev-parse", `${release}^`);
}

/** The anchor is also a command an operator pastes into their own clone, where the forced checkout would discard work. */
function refuseUncommittedChanges(cwd: string): void {
  const dirty = git(cwd, "status", "--porcelain", "--untracked-files=no")
    .split("\n")
    .filter(Boolean);
  if (dirty.length > 0) {
    throw new Error(
      `this checkout has uncommitted changes to tracked files (${dirty.join("; ")}), and anchoring checks the release PR branch out over them; ` +
        "commit them, or run it from a clean checkout.",
    );
  }
}

/** The anchor commit on the checked-out branch: last-release-sha set to `base`, committed under the bot identity. */
function commitAnchor(cwd: string, config: ReleaseConfig, base: string): void {
  config["last-release-sha"] = base;
  writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  git(cwd, "add", CONFIG_FILE);
  gitWithEnv(
    cwd,
    BOT_IDENTITY,
    "commit",
    "-m",
    "chore: anchor release-please to this release cycle's base",
    "-m",
    "last-release-sha records the main commit this release's notes were built from, so the squash merge itself lands the next cycle's boundary on main: " +
      "release-please lists the commits after it, and cannot find the boundary by tag, because version tags live on packaged commits that are not on main.",
  );
}

/** One attempt: the release PR branch fetched and, when it is built on `sourceSha`, checked out detached, anchored,
 * and pushed. Undefined when a release-please refresh overtook the push, so the caller re-reads the branch; a push
 * refused with the branch unmoved is thrown. */
function anchorAttempt(cwd: string, sourceSha: string): AnchorResult | undefined {
  const branchRef = `refs/heads/${RELEASE_PR_BRANCH}`;
  const observed = git(cwd, "ls-remote", "origin", branchRef).split("\t")[0] ?? "";
  if (observed === "") {
    return { changed: false, reason: "no release PR branch to anchor" };
  }
  git(cwd, "fetch", "--quiet", "--force", "origin", branchRef);

  const base = releaseBase(cwd, sourceSha, "FETCH_HEAD");
  if (base !== sourceSha) {
    return {
      changed: false,
      reason: `the release PR branch is built on ${base}, not on ${sourceSha}; the anchor is the commit the branch is built on, so nothing is stamped`,
    };
  }

  refuseUncommittedChanges(cwd);
  // Detached, never a local branch: a retry after an overtaken push re-fetches, and git refuses to fetch into a checked-out ref.
  git(cwd, "checkout", "--quiet", "--force", "--detach", "FETCH_HEAD");
  const config = readReleaseConfig(cwd);
  if (config["last-release-sha"] === sourceSha) {
    return { changed: false, reason: "already anchored" };
  }

  commitAnchor(cwd, config, sourceSha);
  const refused = push(cwd, "origin", `HEAD:${branchRef}`);
  if (refused === null) {
    return { changed: true, reason: `${RELEASE_PR_BRANCH}: anchored at ${sourceSha}` };
  }
  if ((git(cwd, "ls-remote", "origin", branchRef).split("\t")[0] ?? "") === observed) {
    throw refused;
  }
  return undefined;
}

/** The boundary rides INSIDE the release PR as last-release-sha = the main commit release-please built the branch
 * on, so the squash merge lands it on main with no push to main and no admin credential. release-please lists the
 * commits after it, so the next cycle starts where this release's notes end, whatever lands on main before the merge.
 *
 * Stamped only when that commit is `sourceSha`: release-please reads main's history for the notes, then main's head
 * for the branch, and the platform proposes only while main stands at the run's commit.
 *   built on the run's commit  -> nothing landed between the two reads, so the notes end at it
 *   built on another commit    -> no stamp: this run cannot tell where the notes end */
export function anchorReleasePr(options: AnchorOptions): AnchorResult {
  const { cwd, sourceSha, attempts = 3 } = options;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = anchorAttempt(cwd, sourceSha);
    if (result !== undefined) {
      return result;
    }
    // release-please force-pushed a refresh mid-anchor; reapply on it.
    console.error(
      `anchor push attempt ${attempt}/${attempts} overtaken by a refresh; re-reading the branch`,
    );
  }
  throw new Error(
    `could not anchor ${RELEASE_PR_BRANCH} after ${attempts} attempts; something keeps rewriting the branch - rerun this job once the branch settles.`,
  );
}

/** The verdict with no release merge on the history: the pre-first-release state when nothing is recorded, else a
 * refusal saying why the recorded boundary has no merge. */
function noMergeVerdict(cwd: string, recorded: string | undefined): { boundary: string } {
  if (recorded === undefined) {
    return { boundary: "none (no release merge on this history yet)" };
  }
  const cause = isAncestor(cwd, recorded, "HEAD")
    ? `this history holds it, so release-please's merge subject no longer matches ${RELEASE_SUBJECT} (investigate RELEASE_SUBJECT)`
    : "it is not on this history at all (not main, or a boundary that never landed)";
  throw new Error(
    `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, but no release merge is reachable from HEAD: ${cause}. Refusing to read a recorded boundary as a pre-first-release history.`,
  );
}

/** Whether `sha` is a commit of the cycle a release merge closed: on main at or before `parent`, the merge's parent,
 * and after the release merge before it. The first release merge on a history has none before it, so its cycle
 * reaches back to the root. */
function inCycle(cwd: string, sha: string, parent: string): boolean {
  if (!isAncestor(cwd, sha, parent)) {
    return false;
  }
  const previous = newestRelease(cwd, parent);
  return previous === "" || (sha !== previous && isAncestor(cwd, previous, sha));
}

/** On main, last-release-sha must be the newest release merge or a commit of the cycle that merge closed. Which
 * commit of the cycle is the release PR's anchor-check to judge: a squash merge no longer shows it.
 *   outside the cycle                  -> an anchor was lost or a release merge slipped past the pipeline: refused
 *   NEWER than every recognized merge  -> a missed merge or a hand edit: refused, and never rolled back */
export function boundaryCheck(cwd: string): { boundary: string } {
  assertFullHistory(
    cwd,
    "boundary-check",
    "a release merge or the recorded boundary can sit beyond its depth, and no verdict on a truncated history holds.",
  );
  const recorded = readReleaseConfig(cwd)["last-release-sha"];
  const latest = newestRelease(cwd);
  if (latest === "") {
    return noMergeVerdict(cwd, recorded);
  }
  const parent = tryGit(cwd, "rev-parse", `${latest}^`);
  if (recorded !== undefined) {
    if (recorded === latest || (parent !== null && inCycle(cwd, recorded, parent))) {
      return { boundary: recorded };
    }
    if (isAncestor(cwd, latest, recorded) && isAncestor(cwd, recorded, "HEAD")) {
      throw new Error(
        `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, NEWER than ` +
          `${latest}, the newest release merge whose subject matches ${RELEASE_SUBJECT}: either a ` +
          `newer release merge's subject stopped matching (investigate RELEASE_SUBJECT) or the ` +
          `boundary was edited by hand. It must not be rolled back to ${parent ?? latest}.`,
      );
    }
  }
  throw new Error(
    `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, which is not in the cycle the newest release merge on main closed ` +
      `(${latest}, parent ${parent}): an anchor was lost or the value was edited, and release PR refreshes would be computed from a stale boundary. ` +
      `Fix by PR: set last-release-sha to ${parent ?? latest}.`,
  );
}

/** Run on the release PR's head with its history. last-release-sha must be the main commit release-please built the
 * branch on, whatever landed on main since and however often main was merged into the branch, so an unanchored or
 * wrongly anchored release PR is unmergeable instead of parking the pipeline after its merge. */
export function anchorCheck(cwd: string): { boundary: string } {
  assertFullHistory(
    cwd,
    "anchor-check",
    "the commit release-please built the branch on is read from the branch's own history.",
  );
  const recorded = readReleaseConfig(cwd)["last-release-sha"];
  const base = releaseBase(cwd, MAIN, "HEAD");
  if (!isAncestor(cwd, base, MAIN)) {
    throw new Error(
      `release-please's commit on this release PR sits on ${base}, which is not on main: the branch was rebased or a commit was ` +
        `stacked under it, so the commit its notes were built from cannot be read.\n${REBUILD}`,
    );
  }
  if (recorded !== base) {
    throw new Error(
      `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, but release-please built this release PR on ${base}, ` +
        "the commit its notes were built from; the anchor is missing or names another commit, so merging would land a wrong boundary.\n" +
        "Repair it with the command below, from a clean checkout: it leaves HEAD detached on the release PR branch, and its push re-runs the checks. " +
        'When it answers "already anchored", the branch was anchored after this run began: close and reopen the PR to run the checks on its head.\n' +
        `  GITHUB_SHA=${base} bun .github/scripts/release-pipeline.ts anchor`,
    );
  }
  return { boundary: base };
}
