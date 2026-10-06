/**
 * release-please's boundary: last-release-sha in release-please-config.json, anchored inside the release PR branch
 * so the squash merge lands it on main, checked fresh on main and present on the release PR. The config is read
 * once here and refused when malformed, never repaired.
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

const CONFIG_FILE = "release-please-config.json";

/** A squash-merged release-please PR's subject on main. Anchored at both ends wherever release merges are recognized:
 * a prefix match would let "chore(main): release pipeline documentation" impersonate one and park the boundary check. */
const RELEASE_SUBJECT = /^chore\(main\): release (\d+\.\d+\.\d+)(?: \(#\d+\))?$/;

/** checks.yml's head_ref conditions spell this by hand; test/workflows/checks-workflow.test.ts pins them to it. */
export const RELEASE_PR_BRANCH_PREFIX = "release-please--";
const RELEASE_PR_BRANCH = `${RELEASE_PR_BRANCH_PREFIX}branches--main`;

/** release-please's config with the one key this pipeline reads and writes; the rest is release-please's. */
type ReleaseConfig = Record<string, unknown> & { "last-release-sha"?: string };

/** The config as the checkout holds it. The file is the user's and release-please's, so nothing here is repaired: a
 * missing or malformed one, or a boundary that is no commit sha, is refused naming the file (an absent boundary is
 * the pre-first-release state and passes). */
function readReleaseConfig(cwd: string): ReleaseConfig {
  let text: string;
  try {
    text = readFileSync(join(cwd, CONFIG_FILE), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") {
      throw error;
    }
    throw new Error(
      `${CONFIG_FILE} is missing from ${cwd}; the release pipeline reads release-please's boundary (last-release-sha) from it. Restore it by PR.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix it by PR.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed)
      ? "an array"
      : parsed === null
        ? "null"
        : `a ${typeof parsed}`;
    throw new Error(`${CONFIG_FILE} holds ${kind}, not a JSON object; fix it by PR.`);
  }
  const config = parsed as Record<string, unknown>;
  const boundary = config["last-release-sha"];
  if (boundary !== undefined && (typeof boundary !== "string" || !FULL_SHA.test(boundary))) {
    throw new Error(
      `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(boundary)}, not a 40-hex commit sha; fix it by PR.`,
    );
  }
  return config as ReleaseConfig;
}

export interface AnchorOptions {
  cwd: string;
  /** Main's head this run tested; the merge parent the boundary records. */
  sourceSha: string;
  attempts?: number;
}

export interface AnchorResult {
  changed: boolean;
  reason: string;
}

/** The boundary rides INSIDE the release PR as last-release-sha = main's current head, the future merge commit's
 * PARENT (known now, unlike the merge sha), so the squash merge lands it on main with no push to main and no admin credential.
 *   the parent, not the merge  -> the changelog walk then also includes the merge itself, a chore commit it hides anyway
 *   a stale parent             -> ruled out by the managed release-freshness gate: a PR must contain main's tip to merge */
export function anchorReleasePr(options: AnchorOptions): AnchorResult {
  const { cwd, sourceSha, attempts = 3 } = options;
  // If main moved, the newer push's run refreshes the branch and anchors the newer head.
  const head = git(cwd, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
  if (head !== sourceSha) {
    return { changed: false, reason: `main moved to ${head ?? "?"}; the newer run anchors` };
  }
  const branchRef = `refs/heads/${RELEASE_PR_BRANCH}`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const observed = git(cwd, "ls-remote", "origin", branchRef).split("\t")[0] ?? "";
    if (observed === "") {
      return { changed: false, reason: "no release PR branch to anchor" };
    }
    // Detached, never a local branch: a retry after an overtaken push re-fetches, and git refuses to fetch into a checked-out ref.
    git(cwd, "fetch", "--quiet", "--force", "origin", branchRef);
    git(cwd, "checkout", "--quiet", "--force", "--detach", "FETCH_HEAD");
    // A branch still built from an older main must not be stamped with this head. A shallow history that cannot
    // prove ancestry no-ops the same way; the refresh that follows anchors.
    if (!isAncestor(cwd, sourceSha, "FETCH_HEAD")) {
      return {
        changed: false,
        reason: "the release PR branch is not built on this head; its own refresh anchors",
      };
    }
    const config = readReleaseConfig(cwd);
    if (config["last-release-sha"] === sourceSha) {
      return { changed: false, reason: "already anchored" };
    }
    config["last-release-sha"] = sourceSha;
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
    git(cwd, "add", CONFIG_FILE);
    gitWithEnv(
      cwd,
      BOT_IDENTITY,
      "commit",
      "-m",
      "chore: anchor release-please to this release cycle's base",
      "-m",
      "last-release-sha records the merge parent so the squash merge itself lands the next cycle's boundary on main: version tags live on packaged commits that are not on main, so release-please cannot find the boundary by tag.",
    );
    // A newer push's run may already have refreshed and anchored the branch before the fetch above: this run's commit
    // then descends from that anchor, pushes cleanly, and regresses the boundary to the older head.
    const headNow = git(cwd, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
    if (headNow !== sourceSha) {
      return { changed: false, reason: `main moved to ${headNow ?? "?"}; the newer run anchors` };
    }
    const refused = push(cwd, "origin", `HEAD:${branchRef}`);
    if (refused === null) {
      return { changed: true, reason: `${RELEASE_PR_BRANCH}: anchored at ${sourceSha}` };
    }
    if ((git(cwd, "ls-remote", "origin", branchRef).split("\t")[0] ?? "") === observed) {
      throw refused;
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

/** On main, last-release-sha must be the newest release merge or its parent; anything else means an anchor was lost
 * or a release merge slipped past the pipeline, and every release PR refresh would compute from a stale boundary.
 * A boundary NEWER than every recognized merge is a missed merge or a hand edit; either way it is never rolled back. */
export function boundaryCheck(cwd: string): { boundary: string } {
  assertFullHistory(
    cwd,
    "boundary-check",
    "a release merge or the recorded boundary can sit beyond its depth, and no verdict on a truncated history holds.",
  );
  const recorded = readReleaseConfig(cwd)["last-release-sha"];
  // The grep only narrows (it matches any message line with the prefix); RELEASE_SUBJECT decides, so
  // "chore(main): release pipeline documentation" can neither become the boundary nor hide the real newest merge.
  const listed = git(cwd, "log", "--grep", "^chore(main): release ", "--format=%H%x09%s");
  let latest = "";
  for (const line of listed.split("\n")) {
    const [sha, subject] = line.split("\t");
    if (sha !== undefined && subject !== undefined && RELEASE_SUBJECT.test(subject)) {
      latest = sha;
      break;
    }
  }
  if (latest === "") {
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
  const parent = tryGit(cwd, "rev-parse", `${latest}^`);
  if (recorded !== undefined) {
    if (recorded === latest || (parent !== null && recorded === parent)) {
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
    `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, but the newest release ` +
      `merge on main is ${latest} (parent ${parent}); release PR refreshes would be computed ` +
      `from a stale boundary. Fix by PR: set last-release-sha to ${parent ?? latest}.`,
  );
}

/** Run on the release PR's own checkout. The managed release-freshness gate proves the PR contains main's tip, not
 * that the anchor commit survived a release-please force-push, so requiring last-release-sha to equal origin's
 * CURRENT main tip makes an unanchored release PR unmergeable instead of parking the pipeline after its merge. */
export function anchorCheck(cwd: string): { boundary: string } {
  const recorded = readReleaseConfig(cwd)["last-release-sha"];
  const tip = git(cwd, "ls-remote", "origin", "refs/heads/main").split("\t")[0] ?? "";
  if (recorded !== tip) {
    throw new Error(
      `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, but main's tip is ` +
        `${tip}; the anchor is missing or stale, so merging would land a wrong boundary. ` +
        `The release pipeline's update-release-pr hook re-applies it on every release-PR refresh ` +
        `- wait for (or dispatch) the next green main run, then close/reopen the PR so its ` +
        `checks run on the anchored head (the anchor is pushed with the default token, which ` +
        `triggers no new checks).`,
    );
  }
  return { boundary: recorded };
}
