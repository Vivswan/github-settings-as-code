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

/** release-please's changelog at the checkout root: what a release merge adds to it is that release's notes. */
const CHANGELOG_FILE = "CHANGELOG.md";

/** A commit as release-please's notes link it. */
const COMMIT_LINK = /\/commit\/([0-9a-f]{40})\b/g;

/** A squash-merged release-please PR's subject on main, anchored at both ends wherever release merges are recognized: a prefix match would let "chore(main): release pipeline documentation" impersonate one and park the boundary check. */
const RELEASE_SUBJECT = /^chore\(main\): release (\d+\.\d+\.\d+)(?: \(#\d+\))?$/;

/** checks.yml's head_ref conditions spell this by hand; test/workflows/checks-workflow.test.ts pins them to it. */
export const RELEASE_PR_BRANCH_PREFIX = "release-please--";

/** release-please's branch for main's release PR. */
const RELEASE_PR_BRANCH = `${RELEASE_PR_BRANCH_PREFIX}branches--main`;

/** Main as a full-history checkout of the release PR's head holds it. */
const MAIN = "origin/main";

/** The repair of a release PR branch whose base cannot be read or trusted: release-please builds a new one once this one is gone. */
const REBUILD = `Delete the branch, and the next green push to main has release-please rebuild the release PR and the hook anchor it:\n  git push origin --delete ${RELEASE_PR_BRANCH}`;

/** release-please's config with the one key this pipeline reads and writes; the rest is release-please's. */
type ReleaseConfig = Record<string, unknown> & { "last-release-sha"?: string };

/** A release commit: release-please's own on a release PR branch, its squash merge on main. */
interface Release {
  /** Its full sha, as `git log` prints %H. */
  sha: string;

  /** The X.Y.Z its subject names. */
  version: string;
}

/** How a release PR branch's last-release-sha stands against the commit the branch is built on.
 *   anchored  -> it is that commit
 *   missing   -> main's own value: the branch has no anchor commit
 *   moved     -> an older commit: the release commit moved after its stamp, or the value was edited back
 *   edited    -> any other value */
type AnchorState = "anchored" | "missing" | "moved" | "edited";

/** A refusal as an operator reads one in a CI log: what is wrong on the first line, then one repair per line, a
 * command alone on the line under its repair. */
function refusal(...lines: string[]): Error {
  return new Error(lines.join("\n"));
}

/** The refusal of a config that `where`, a checkout or a commit, does not hold. */
function missingConfig(where: string): Error {
  return refusal(
    `${CONFIG_FILE} is missing from ${where}: the release pipeline reads release-please's boundary (last-release-sha) from it.`,
    "Restore it by PR.",
  );
}

/** The config's text; a missing file is refused naming it, any other read failure is thrown as it came. */
function readConfigText(cwd: string): string {
  try {
    return readFileSync(join(cwd, CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      throw error;
    }
    throw missingConfig(cwd);
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
    throw refusal(
      `${CONFIG_FILE} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
      "Fix it by PR.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw refusal(`${CONFIG_FILE} holds ${jsonKind(parsed)}, not a JSON object.`, "Fix it by PR.");
  }
  return parsed as Record<string, unknown>;
}

/** `text` as release-please's config. The file is the user's and release-please's, so nothing here is repaired: a
 * malformed one, or a boundary that is no commit sha, is refused naming the file (an absent boundary is the
 * pre-first-release state and passes). */
function parseReleaseConfig(text: string): ReleaseConfig {
  const config = parseConfigObject(text);
  const boundary = config["last-release-sha"];
  if (boundary !== undefined && (typeof boundary !== "string" || !FULL_SHA.test(boundary))) {
    throw refusal(
      `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(boundary)}, not a 40-hex commit sha.`,
      "Fix it by PR.",
    );
  }
  return config as ReleaseConfig;
}

/** The config as the checkout holds it. */
function readReleaseConfig(cwd: string): ReleaseConfig {
  return parseReleaseConfig(readConfigText(cwd));
}

/** The config as the commit `rev` holds it. */
function releaseConfigAt(cwd: string, rev: string): ReleaseConfig {
  const text = tryGit(cwd, "show", `${rev}:${CONFIG_FILE}`);
  if (text === null) {
    throw missingConfig(`commit ${rev}`);
  }
  return parseReleaseConfig(text);
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

/** The newest release commit `git log` lists for `revs` (HEAD when none), or undefined for none. The grep only
 * narrows (it matches any message line with the prefix); RELEASE_SUBJECT decides, so "chore(main): release pipeline
 * documentation" can neither become the boundary nor hide the real newest release commit. */
function newestRelease(cwd: string, ...revs: string[]): Release | undefined {
  const listed = git(cwd, "log", "--grep", "^chore(main): release ", "--format=%H%x09%s", ...revs);
  for (const line of listed.split("\n")) {
    const [sha, subject] = line.split("\t");
    const version = RELEASE_SUBJECT.exec(subject ?? "")?.[1];
    if (sha !== undefined && version !== undefined) {
      return { sha, version };
    }
  }
  return undefined;
}

/** The commit a release PR branch is built on: the first parent of the newest release commit on the branch's
 * first-parent chain above `main`. The bound matters: a walk into main's own history would read main's last release
 * merge on a branch that holds no release commit. */
function releaseBase(cwd: string, main: string, branch: string): string {
  const release = newestRelease(cwd, "--first-parent", `${main}..${branch}`);
  if (release === undefined) {
    throw refusal(
      `the release PR branch holds no release commit ("chore(main): release X.Y.Z") on its first-parent chain above ${main}.`,
      "The commit its notes were built from cannot be read: main was merged in with the branch as the second parent, or release-please did not build this branch.",
      REBUILD,
    );
  }
  return git(cwd, "rev-parse", `${release.sha}^`);
}

/** Where `recorded`, a release PR branch's last-release-sha, stands against `base`, the commit the branch is built
 * on. The check and the command both ask here, so neither stamps what the other refuses. Telling an older commit
 * from any other needs the history: a shallow checkout that must tell is refused, never guessed for. */
function anchorState(cwd: string, recorded: string | undefined, base: string): AnchorState {
  if (recorded === base) {
    return "anchored";
  }

  if (recorded === releaseConfigAt(cwd, base)["last-release-sha"]) {
    return "missing";
  }

  if (recorded === undefined) {
    return "edited";
  }

  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw refusal(
      `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, and this shallow checkout cannot tell whether that is an older commit than ${base}.`,
      "Run the command from a clone that holds the full history:",
      `  GITHUB_SHA=${base} bun .github/scripts/release-pipeline.ts anchor`,
    );
  }

  return isAncestor(cwd, recorded, base) ? "moved" : "edited";
}

/** What an unanchored release PR is refused with. The moved state names the rebuild alone: stamping `base` there
 * would leave every commit between the two out of this release's notes and out of the next cycle. */
function notAnchored(
  state: Exclude<AnchorState, "anchored">,
  recorded: string | undefined,
  base: string,
): Error {
  const value = `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}`;
  if (state === "moved") {
    return refusal(
      `${value}, an older commit than ${base}, which this release PR is built on.`,
      "The branch moved after it was anchored, or the anchor was edited: the notes may lack the commits between the two, so no stamp is offered.",
      REBUILD,
    );
  }

  const cause = {
    missing: "the branch carries no anchor commit",
    edited: "the anchor names another commit",
  };
  return refusal(
    `${value}, but release-please built this release PR on ${base}: ${cause[state]}.`,
    "Stamp it from a clean checkout; the command leaves HEAD detached on the release PR branch, and its push re-runs the checks:",
    `  GITHUB_SHA=${base} bun .github/scripts/release-pipeline.ts anchor`,
    'If it answers "already anchored", close and reopen the PR to run the checks on its head.',
  );
}

/** The anchor is also a command an operator pastes into their own clone, where the checkout would carry uncommitted
 * work along, and staged work into the anchor commit. */
function refuseUncommittedChanges(cwd: string): void {
  const dirty = git(cwd, "status", "--porcelain", "--untracked-files=no")
    .split("\n")
    .filter(Boolean);
  if (dirty.length > 0) {
    throw refusal(
      `this checkout has uncommitted changes to tracked files (${dirty.join("; ")}), and anchoring checks the release PR branch out.`,
      "Run the command from a clean checkout: commit the changes first, or use another clone.",
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

/** One attempt: the release PR branch fetched and, when it is built on `sourceSha` and its anchor is missing or
 * edited, checked out detached, anchored, and pushed. Undefined when a release-please refresh overtook the push, so
 * the caller re-reads the branch; a push refused with the branch unmoved is thrown. */
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

  const config = releaseConfigAt(cwd, "FETCH_HEAD");
  const state = anchorState(cwd, config["last-release-sha"], sourceSha);
  if (state === "anchored") {
    return { changed: false, reason: "already anchored" };
  }
  if (state === "moved") {
    throw notAnchored(state, config["last-release-sha"], sourceSha);
  }

  refuseUncommittedChanges(cwd);
  // Detached, never a local branch: a retry after an overtaken push re-fetches, and git refuses to fetch into a checked-out ref.
  // Unforced, ignored files included: git then refuses to overwrite a file of the operator's that the branch tracks.
  git(cwd, "checkout", "--quiet", "--detach", "--no-overwrite-ignore", "FETCH_HEAD");
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
  throw refusal(
    `could not anchor ${RELEASE_PR_BRANCH} after ${attempts} attempts: something keeps rewriting the branch.`,
    "Rerun this job once the branch settles.",
  );
}

/** The verdict with no release merge on the history: the pre-first-release state when nothing is recorded, else a
 * refusal saying why the recorded boundary has no merge. A recorded boundary is never read as that state. */
function noMergeVerdict(cwd: string, recorded: string | undefined): { boundary: string } {
  if (recorded === undefined) {
    return { boundary: "none (no release merge on this history yet)" };
  }

  const wrong = `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, but no release merge is reachable from HEAD.`;
  if (isAncestor(cwd, recorded, "HEAD")) {
    throw refusal(
      wrong,
      `This history holds that commit, so release-please's merge subject no longer matches ${RELEASE_SUBJECT}.`,
      "Investigate RELEASE_SUBJECT in .github/scripts/release-pipeline/anchor.ts.",
    );
  }
  throw refusal(
    wrong,
    "That commit is not on this history at all: this is not main, or the boundary never landed.",
    "Fix by PR when it never landed: remove last-release-sha, which a history with no release merge does not record.",
  );
}

/** The cycle a release merge closed, newest first: main's commits at or before `parent`, the merge's parent, and
 * after the release merge before it. The first release merge on a history has none before it, so its cycle reaches
 * back to the root. */
function cycleOf(cwd: string, parent: string): string[] {
  const previous = newestRelease(cwd, parent);
  const range =
    previous === undefined ? [parent] : ["--ancestry-path", `${previous.sha}..${parent}`];
  return git(cwd, "rev-list", "--topo-order", ...range)
    .split("\n")
    .filter(Boolean);
}

/** The newest commit a release merge's notes list, or undefined when none reads so: of the commits its changelog
 * diff links, the one of `cycle` that every other is an ancestor of. As the boundary it drops and repeats nothing:
 * the notes hold every changelog-visible commit up to it, and none after it. */
function newestListed(cwd: string, merge: string, cycle: string[]): string | undefined {
  const diff = tryGit(cwd, "diff", "--unified=0", `${merge}^`, merge, "--", CHANGELOG_FILE) ?? "";
  const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++ "));
  const linked = new Set(
    added.flatMap((line) => [...line.matchAll(COMMIT_LINK)].map((link) => link[1])),
  );
  const listed = cycle.filter((sha) => linked.has(sha));
  const newest = listed[0];
  if (newest === undefined) {
    return undefined;
  }

  const beside = git(cwd, "rev-list", "--max-count=1", ...listed, `^${newest}`);
  return beside === "" ? newest : undefined;
}

/** On main, last-release-sha must be the newest release merge or a commit of the cycle it closed. Which commit is
 * anchor-check's to judge: a squash merge no longer shows it.
 *   outside the cycle                  -> a lost anchor or a missed merge: refused, naming the newest commit the
 *                                         release's notes list
 *   NEWER than every recognized merge  -> a missed merge or a hand edit: refused, never rolled back */
export function boundaryCheck(cwd: string): { boundary: string } {
  assertFullHistory(
    cwd,
    "boundary-check",
    "a release merge or the recorded boundary can sit beyond its depth.",
  );
  const recorded = readReleaseConfig(cwd)["last-release-sha"];
  const latest = newestRelease(cwd);
  if (latest === undefined) {
    return noMergeVerdict(cwd, recorded);
  }

  const parent = tryGit(cwd, "rev-parse", `${latest.sha}^`);
  const cycle = parent === null ? [] : cycleOf(cwd, parent);
  if (recorded !== undefined) {
    if (recorded === latest.sha || cycle.includes(recorded)) {
      return { boundary: recorded };
    }
    if (isAncestor(cwd, latest.sha, recorded) && isAncestor(cwd, recorded, "HEAD")) {
      throw refusal(
        `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, NEWER than ${latest.sha}, the newest release merge this check recognizes.`,
        `A newer release merge's subject stopped matching ${RELEASE_SUBJECT}, or the boundary was edited by hand.`,
        `Investigate RELEASE_SUBJECT, and never roll the boundary back to ${latest.sha} or into the cycle it closed.`,
      );
    }
  }

  const wrong = `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, outside the cycle the newest release merge ${latest.sha} closed: an anchor was lost, or the value was edited.`;
  const notes = `the newest commit release ${latest.version}'s notes list`;
  const listed = newestListed(cwd, latest.sha, cycle);
  if (listed === undefined) {
    throw refusal(
      wrong,
      `Fix by PR: set last-release-sha to ${notes}; none could be read here, so find it in:`,
      `  git show ${latest.sha} -- ${CHANGELOG_FILE}`,
    );
  }
  throw refusal(wrong, `Fix by PR: set last-release-sha to ${listed}, ${notes}.`);
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
    throw refusal(
      `release-please's commit on this release PR sits on ${base}, which is not on ${MAIN} as fetched here.`,
      "First fetch main and run the check again:",
      "  git fetch origin",
      "Only when it still fails: the branch was rebased, or a commit was stacked under its release commit.",
      REBUILD,
    );
  }

  const state = anchorState(cwd, recorded, base);
  if (state !== "anchored") {
    throw notAnchored(state, recorded, base);
  }
  return { boundary: base };
}
