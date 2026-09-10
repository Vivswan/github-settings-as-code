/**
 * The single-tag release pipeline's git topology, called step by step from
 * the repo-owned workflows (update-release.yml for the release chain,
 * checks.yml and update-release-pr.yml for the bookkeeping, post-green.yml
 * for latest) and unit-tested against fixture repositories
 * (test/scripts/release-pipeline.test.ts), so "the next release tags the
 * right commits" is proven on every push.
 *
 * The scheme: main is source-only, and every ref a consumer can name - the
 * vX.Y.Z release tags, the moving major vX, and the moving `latest` branch -
 * points ONLY at a packaged commit: a source commit's tree plus the built
 * lib/index.js and nothing else. release-please cuts the DRAFT release itself
 * (no tag: the config sets `draft` without `force-tag-creation`); these
 * subcommands then run, one per workflow step:
 *   package         packageRelease: tag the packaged child ONCE, or
 *                   byte-verify an existing tag. No path moves a tag.
 *   retag-major     retagMajor: force-move the major tag, never backward.
 *   verify          verifyPublishedRefs: origin's actual refs and tree.
 *   anchor          anchorReleasePr: advance last-release-sha on the
 *                   release PR branch (version tags live off main, so
 *                   release-please's boundary is recorded config).
 *   boundary-check  boundaryCheck: main's recorded boundary is fresh.
 *   anchor-check    anchorCheck: the release PR carries the anchor.
 *   advance-latest  advanceLatest: fast-forward latest to a green commit.
 * Env: TAG and GITHUB_SHA (package/retag-major/anchor), GITHUB_SHA
 * (advance-latest), RUN_URL (optional provenance, package/advance-latest).
 * Node builtins only: `bun` runs it pre-install.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILE = ".release-please-manifest.json";
const CONFIG_FILE = "release-please-config.json";
const BUNDLE_FILE = "lib/index.js";
const LATEST_REF = "refs/heads/latest";
/** What a squash-merged release-please PR's subject looks like on main.
 * Matched EXACTLY wherever release merges are recognized: a prefix match
 * would let "chore(main): release pipeline documentation" impersonate a
 * release merge and park the boundary check. */
const RELEASE_SUBJECT = /^chore\(main\): release (\d+\.\d+\.\d+)(?: \(#\d+\))?$/;

/** Run git in cwd, returning trimmed stdout; rethrows with the command and
 * its stderr so a CI failure names the git call that produced it. */
function git(cwd: string, ...args: string[]): string {
  return gitWithEnv(cwd, {}, ...args);
}

/** git() with extra environment (GIT_INDEX_FILE for the private index). */
function gitWithEnv(cwd: string, env: Record<string, string>, ...args: string[]): string {
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

/** A yes/no git question: exit 0 is yes, exit 1 is no, anything else is a failure and throws. */
function gitYesNo(cwd: string, ...args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) {
      return false;
    }
    throw gitFailure(args, error);
  }
}

/** git() for byte-exact output (the bundle comparison must not decode). */
function gitBytes(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd });
}

/** git() returning null instead of throwing, for existence probes. */
function tryGit(cwd: string, ...args: string[]): string | null {
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

/** The identity the pipeline's own commits (packaged child, anchor) carry. */
function configureIdentity(cwd: string): void {
  git(cwd, "config", "user.name", "settings-as-code-release");
  git(cwd, "config", "user.email", "settings-as-code-release@users.noreply.github.com");
}

/** The one tag shape the scheme mints. Every ref derivation goes through
 * this parse, so a malformed tag stops the pipeline instead of minting a
 * wrong major (e.g. "v2" from "v2.1-rc.0"). */
function releaseMajor(tag: string): string {
  const match = tag.match(/^v(\d+)\.\d+\.\d+$/);
  if (!match) {
    throw new Error(
      `tag ${JSON.stringify(tag)} is not a vX.Y.Z release tag; refusing to derive version refs from it.`,
    );
  }
  return `v${match[1]}`;
}

/**
 * The invariant every consumable ref must satisfy before consumers can be
 * pointed at it: the tree carries the bundle as a non-empty REGULAR file (a
 * symlink or a gitlink at that path has a size too, and no bundle). Asserted
 * on every path that mints or blesses a ref - fresh package (before the
 * push), rerun verification, the major move, and the latest advance.
 * Returns the entry so a caller can rebuild the tree it belongs in.
 */
function assertCarriesBundle(cwd: string, treeish: string): { mode: string; blob: string } {
  const entry = tryGit(cwd, "ls-tree", "-l", treeish, "--", BUNDLE_FILE) ?? "";
  const [mode = "", , blob = "", size] = entry.split(/\s+/);
  const regularFile = mode === "100644" || mode === "100755";
  if (!regularFile || Number(size) === 0) {
    const found = entry === "" ? "no entry" : `entry ${entry.split("\t")[0]}`;
    throw new Error(
      `${treeish} does not carry a non-empty regular-file ${BUNDLE_FILE} (${found}); refusing to point a consumable ref at an unpackaged commit.`,
    );
  }
  return { mode, blob };
}

/**
 * sourceSha's tree plus whatever `addBundle` stages at BUNDLE_FILE, and
 * nothing else: assembled in a private index read from sourceSha's tree, so
 * no other path can enter it and the checkout's own index stays untouched.
 */
function treePlusBundle(
  cwd: string,
  sourceSha: string,
  addBundle: (env: Record<string, string>) => void,
): string {
  const indexFile = join(git(cwd, "rev-parse", "--absolute-git-dir"), "release-pipeline.index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    gitWithEnv(cwd, env, "read-tree", sourceSha);
    addBundle(env);
    return gitWithEnv(cwd, env, "write-tree");
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/**
 * The one definition of "packaged is source's package", asserted wherever a
 * ref that already exists is blessed (a tagged rerun, the major move, every
 * latest tip): packaged's tree IS the tree rebuilt from source plus
 * packaged's own bundle entry. Tree identity, not a path diff: a diff lists
 * paths, so an extra empty subtree or a rename hides from it, while no tree
 * object hides from its own id. `remedy` tells the operator what to do.
 */
function assertPackages(
  cwd: string,
  packaged: string,
  source: string,
  ref: string,
  remedy: string,
): void {
  const { mode, blob } = assertCarriesBundle(cwd, packaged);
  const expected = treePlusBundle(cwd, source, (env) =>
    gitWithEnv(cwd, env, "update-index", "--add", "--cacheinfo", `${mode},${blob},${BUNDLE_FILE}`),
  );
  const actual = git(cwd, "rev-parse", `${packaged}^{tree}`);
  if (actual !== expected) {
    const changed = git(cwd, "diff", "--no-renames", "--name-only", source, packaged)
      .split("\n")
      .filter((path) => path !== "" && path !== BUNDLE_FILE);
    const listed =
      changed.length === 0
        ? "none (an entry a path diff cannot list, such as an empty subtree)"
        : changed.join(", ");
    throw new Error(
      `${ref} is not ${source} plus ${BUNDLE_FILE} alone: its tree is ${actual}, the rebuilt one is ${expected} (paths beyond the bundle changed relative to ${source}: ${listed}); ${remedy}`,
    );
  }
}

/**
 * The tree every packaged commit carries: sourceSha's tree plus the bundle
 * built in the checkout. The checkout must BE sourceSha with a clean
 * worktree: that is what makes the bundle a build of that source rather
 * than of a by-hand edit (the bundle itself is gitignored and never shows
 * as pending).
 */
function packagedTree(cwd: string, sourceSha: string): string {
  const head = git(cwd, "rev-parse", "HEAD");
  if (head !== sourceSha) {
    throw new Error(`the checkout is at ${head}, not the source commit ${sourceSha} to package.`);
  }
  if (!existsSync(join(cwd, BUNDLE_FILE))) {
    throw new Error(`${BUNDLE_FILE} is not built; run the build before packaging.`);
  }
  const dirty = git(cwd, "status", "--porcelain").split("\n").filter(Boolean);
  if (dirty.length > 0) {
    throw new Error(
      `the worktree has pending changes beyond ${BUNDLE_FILE} (${dirty.join("; ")}); the bundle must be a build of ${sourceSha} alone - commit, stash, or clean them first.`,
    );
  }
  // -f: main gitignores the bundle
  const tree = treePlusBundle(cwd, sourceSha, (env) =>
    gitWithEnv(cwd, env, "add", "-f", BUNDLE_FILE),
  );
  assertCarriesBundle(cwd, tree);
  return tree;
}

/** Commit a packaged tree under the pipeline's identity; `paragraphs` become the message, one per -m. */
function commitPackaged(cwd: string, tree: string, parent: string, paragraphs: string[]): string {
  configureIdentity(cwd);
  const message = paragraphs.flatMap((paragraph) => ["-m", paragraph]);
  return git(cwd, "commit-tree", "-p", parent, ...message, tree);
}

export interface PackageOptions {
  cwd: string;
  tag: string;
  /** The release-please merge commit this run tested; the tag's parent. */
  sourceSha: string;
  /** Provenance trailer for the packaged commit (the workflow run URL). */
  runUrl?: string;
}

export interface PackagedRelease {
  created: boolean;
  packagedSha: string;
}

/**
 * Create the packaged commit and its version tag, exactly once. The worktree
 * must be the merge commit with the bundle freshly built; a rerun finds the
 * tag on origin and byte-verifies it instead (parent, whole tree, bundle
 * bytes), so no rerun can move or replace a tag - a mismatch is a loud stop.
 */
export function packageRelease(options: PackageOptions): PackagedRelease {
  const { cwd, tag, sourceSha, runUrl } = options;
  releaseMajor(tag); // shape gate: nothing downstream may mint a non-vX.Y.Z ref
  const tree = packagedTree(cwd, sourceSha);
  // The tag must be the version THIS source released: a hand recovery with
  // the wrong TAG, or a draft whose metadata points at the wrong commit,
  // must stop here rather than mint an immutable tag from the wrong source.
  const manifest = JSON.parse(git(cwd, "show", `HEAD:${MANIFEST_FILE}`)) as Record<string, unknown>;
  if (tag !== `v${manifest["."]}`) {
    throw new Error(
      `tag ${tag} does not match the manifest version ${JSON.stringify(manifest["."])} at ${sourceSha}; refusing to package a version this source did not release.`,
    );
  }
  const ref = `refs/tags/${tag}`;
  // A standalone git() propagates a failing ls-remote, so a transport error
  // cannot read as "the tag does not exist".
  const existing = git(cwd, "ls-remote", "origin", ref);
  if (existing !== "") {
    git(cwd, "fetch", "--quiet", "--depth=2", "origin", `+${ref}:${ref}`);
    return { created: false, packagedSha: verifyPackagedTag(cwd, tag, sourceSha) };
  }
  const message = [`build: package ${tag}`, `source: ${sourceSha}`];
  if (runUrl !== undefined) {
    message.push(`workflow run: ${runUrl}`);
  }
  const packagedSha = commitPackaged(cwd, tree, sourceSha, message);
  git(cwd, "tag", tag, packagedSha);
  git(cwd, "push", "origin", ref);
  return { created: true, packagedSha };
}

/**
 * Prove an existing version tag is THIS source's package: parented on the
 * merge commit, changing nothing but the bundle (a planted commit that keeps
 * the expected bundle but edits action.yml would otherwise pass), and
 * carrying exactly the bytes the fresh build in the worktree produced.
 */
function verifyPackagedTag(cwd: string, tag: string, sourceSha: string): string {
  const frozen =
    "the release-tags ruleset freezes version tags, so no rerun can replace it - inspect it by hand.";
  const packagedSha = git(cwd, "rev-parse", `refs/tags/${tag}^{}`);
  const parent = git(cwd, "rev-parse", `${packagedSha}^`);
  if (parent !== sourceSha) {
    throw new Error(
      `refs/tags/${tag} exists but its parent is ${parent}, not this release's merge commit ${sourceSha}; ${frozen}`,
    );
  }
  assertPackages(cwd, packagedSha, sourceSha, `refs/tags/${tag} (${packagedSha})`, frozen);
  const tagged = gitBytes(cwd, "show", `${packagedSha}:${BUNDLE_FILE}`);
  if (!tagged.equals(readFileSync(join(cwd, BUNDLE_FILE)))) {
    throw new Error(
      `refs/tags/${tag} carries a ${BUNDLE_FILE} that is not a build of ${sourceSha}'s source; ${frozen}`,
    );
  }
  return packagedSha;
}

export interface RetagMajorOptions {
  cwd: string;
  tag: string;
  sourceSha: string;
}

/**
 * Force-move the moving major tag (v2 for a v2.x.y release) to the version
 * tag's packaged commit, re-verified against origin from scratch (the local
 * ref is never trusted): major-pinned consumers must never receive an
 * unpackaged commit, a package of the wrong source, or - on a rerun of an
 * old release's job - a step backward to an older release than the line
 * already shipped. The push is a compare-and-swap (--force-with-lease on
 * the observed major), so a concurrent newer release cannot be clobbered
 * between the newest-check and the push; a lost lease re-evaluates.
 */
export function retagMajor(options: RetagMajorOptions): { major: string; packagedSha: string } {
  const { cwd, tag, sourceSha } = options;
  const ref = `refs/tags/${tag}`;
  git(cwd, "fetch", "--quiet", "--depth=2", "origin", `+${ref}:${ref}`);
  // The full packaged-tag verification (parent, whole tree, bundle bytes),
  // not a weaker parent-only probe: the major must never bless a child a
  // fresh package run would refuse, however this command was reached.
  const packagedSha = verifyPackagedTag(cwd, tag, sourceSha);
  const major = releaseMajor(tag);
  configureIdentity(cwd);
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const newest = newestInLine(cwd, major);
    if (newest !== null && newest !== tag) {
      throw new Error(
        `${newest} already exists in the ${major} line, so ${major} must stay on it; refusing to move ${major} back to ${tag} (a rerun of an old release's job must not regress major-pinned consumers).`,
      );
    }
    const observed = git(cwd, "ls-remote", "origin", `refs/tags/${major}`).split("\t")[0] ?? "";
    git(cwd, "tag", "-f", major, packagedSha);
    try {
      git(
        cwd,
        "push",
        `--force-with-lease=refs/tags/${major}:${observed}`,
        "origin",
        `refs/tags/${major}`,
      );
      return { major, packagedSha };
    } catch (error) {
      console.error(`major lease push attempt ${attempt}/${attempts} lost: ${String(error)}`);
    }
  }
  throw new Error(
    `could not move ${major} after ${attempts} compare-and-swap attempts; something is moving it concurrently - inspect the tag by hand.`,
  );
}

/** The highest vX.Y.Z tag origin has in a major line, or null when the line
 * is untagged (this release is its first). */
function newestInLine(cwd: string, major: string): string | null {
  const listed = git(cwd, "ls-remote", "origin", `refs/tags/${major}.*`);
  let newest: number[] | null = null;
  for (const line of listed.split("\n")) {
    const name = line.split("\t")[1];
    const match = name?.match(/^refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
      continue;
    }
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (newest === null || isNewer(parts, newest)) {
      newest = parts;
    }
  }
  return newest === null ? null : `v${newest.join(".")}`;
}

function isNewer(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) {
      return left > right;
    }
  }
  return false;
}

export interface VerifyOptions {
  cwd: string;
  tag: string;
  sourceSha: string;
}

/**
 * The end-of-pipeline confirmation, against origin's ACTUAL state rather
 * than anything this run holds locally: both refs a consumer resolves - the
 * version tag and its major - must point at the packaged child of this
 * release's merge commit, and that commit's tree must carry the bundle.
 */
export function verifyPublishedRefs(options: VerifyOptions): {
  major: string;
  packagedSha: string;
} {
  const { cwd, tag, sourceSha } = options;
  const major = releaseMajor(tag);
  git(
    cwd,
    "fetch",
    "--quiet",
    "--depth=2",
    "origin",
    `+refs/tags/${tag}:refs/verify/${tag}`,
    `+refs/tags/${major}:refs/verify/${major}`,
  );
  const packagedSha = git(cwd, "rev-parse", `refs/verify/${tag}^{}`);
  const parent = git(cwd, "rev-parse", `${packagedSha}^`);
  if (parent !== sourceSha) {
    throw new Error(
      `origin's refs/tags/${tag} points at ${packagedSha} whose parent is ${parent}, not this release's merge commit ${sourceSha}.`,
    );
  }
  assertCarriesBundle(cwd, packagedSha);
  const majorSha = git(cwd, "rev-parse", `refs/verify/${major}^{}`);
  if (majorSha !== packagedSha) {
    throw new Error(
      `origin's refs/tags/${major} points at ${majorSha}, not this release's packaged commit ${packagedSha}; if a newer release moved it during this run, this is stale-run noise - otherwise inspect both tags by hand.`,
    );
  }
  return { major, packagedSha };
}

/** The namespace release-please's PR branch lives under; the workflows' head_ref conditions spell it by hand (pinned by test). */
export const RELEASE_PR_BRANCH_PREFIX = "release-please--";
const RELEASE_PR_BRANCH = `${RELEASE_PR_BRANCH_PREFIX}branches--main`;

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

/**
 * Carry the boundary INSIDE the release PR: append a commit to the
 * release-please branch setting last-release-sha to main's current head,
 * the future merge commit's PARENT (known now, unlike the merge SHA). The
 * squash merge lands it on main as part of the release: no push to main,
 * no admin credential. The release-freshness gate keeps it correct (a PR
 * must contain main's tip to merge, so the parent cannot be stale), and
 * the parent is as good a boundary as the merge: the walk then includes
 * the merge itself, a chore commit the changelog hides.
 */
export function anchorReleasePr(options: AnchorOptions): AnchorResult {
  const { cwd, sourceSha, attempts = 3 } = options;
  // Anchor only the branch built on this head: if main moved, the newer
  // push's run refreshes the branch and anchors the newer head.
  const head = git(cwd, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
  if (head !== sourceSha) {
    return { changed: false, reason: `main moved to ${head ?? "?"}; the newer run anchors` };
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const branchRef = `refs/heads/${RELEASE_PR_BRANCH}`;
    if (git(cwd, "ls-remote", "origin", branchRef) === "") {
      return { changed: false, reason: "no release PR branch to anchor" };
    }
    // Detached on FETCH_HEAD, never a local branch: a retry after a lost
    // push must re-fetch, and git refuses to fetch into a checked-out ref.
    git(cwd, "fetch", "--quiet", "--force", "origin", branchRef);
    git(cwd, "checkout", "--quiet", "--force", "--detach", "FETCH_HEAD");
    // Anchor only a branch release-please built on this head: this
    // workflow also runs for failed CI runs (whose refresh may never have
    // happened), and their anchor must not stamp this head onto a branch
    // still built from an older main. A shallow history that cannot prove
    // ancestry no-ops the same way - the refresh that follows anchors.
    if (!isAncestor(cwd, sourceSha, "FETCH_HEAD")) {
      return {
        changed: false,
        reason: "the release PR branch is not built on this head; its own refresh anchors",
      };
    }
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8")) as {
      "last-release-sha"?: unknown;
    };
    if (config["last-release-sha"] === sourceSha) {
      return { changed: false, reason: "already anchored" };
    }
    config["last-release-sha"] = sourceSha;
    writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
    configureIdentity(cwd);
    git(cwd, "add", CONFIG_FILE);
    git(
      cwd,
      "commit",
      "-m",
      "chore: anchor release-please to this release cycle's base",
      "-m",
      "last-release-sha records the merge parent so the squash merge itself lands the next cycle's boundary on main: version tags live on packaged children that are not on main, so release-please cannot find the boundary by tag.",
    );
    // Recheck main immediately before pushing: the fetch above can lose a
    // race where a newer push's run already refreshed and anchored the
    // branch - this run's commit would descend from that anchor and push
    // cleanly, regressing the boundary to the older head.
    const headNow = git(cwd, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
    if (headNow !== sourceSha) {
      return { changed: false, reason: `main moved to ${headNow ?? "?"}; the newer run anchors` };
    }
    try {
      git(cwd, "push", "origin", `HEAD:${branchRef}`);
      return { changed: true, reason: `${RELEASE_PR_BRANCH}: anchored at ${sourceSha}` };
    } catch (error) {
      // release-please force-pushed a refresh mid-anchor; reapply on it.
      console.error(`anchor push attempt ${attempt}/${attempts} lost: ${String(error)}`);
    }
  }
  throw new Error(
    `could not anchor ${RELEASE_PR_BRANCH} after ${attempts} attempts; something keeps rewriting the branch - rerun this job once the branch settles.`,
  );
}

/**
 * The tripwire behind the anchor: on the checked-out history (main),
 * last-release-sha must be the newest release merge or its parent -
 * anything else means an anchor was lost (or a release merge slipped past
 * the pipeline) and every release PR refresh would be computed from a
 * stale boundary. Loud and gating beats silently wrong changelogs. Only an
 * unrecorded boundary may lack a release merge; one newer than every
 * recognized merge belongs to a merge this check missed, so it is never rolled back.
 */
export function boundaryCheck(cwd: string): { boundary: string } {
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      "boundary-check needs the full history (fetch-depth: 0) and this checkout is shallow: a release merge or the recorded boundary can sit beyond its depth, and no verdict on a truncated history holds.",
    );
  }
  const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8")) as {
    "last-release-sha"?: unknown;
  };
  // The grep narrows candidates cheaply (it matches any message line with
  // the prefix); the strict subject regex then decides, so an ordinary
  // commit like "chore(main): release pipeline documentation" can neither
  // become the boundary nor hide the real newest release merge.
  const listed = git(cwd, "log", "--grep", "^chore(main): release ", "--format=%H%x09%s");
  let latest = "";
  for (const line of listed.split("\n")) {
    const [sha, subject] = line.split("\t");
    if (sha !== undefined && subject !== undefined && RELEASE_SUBJECT.test(subject)) {
      latest = sha;
      break;
    }
  }
  const recorded = config["last-release-sha"];
  if (latest === "") {
    if (recorded === undefined) {
      return { boundary: "none (no release merge on this history yet)" };
    }
    const cause = isAncestor(cwd, String(recorded), "HEAD")
      ? `this history holds it, so release-please's merge subject no longer matches ${RELEASE_SUBJECT} (investigate RELEASE_SUBJECT)`
      : "it is not on this history at all (not main, or a boundary that never landed)";
    throw new Error(
      `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, but no release merge is reachable from HEAD: ${cause}. Refusing to read a recorded boundary as a pre-first-release history.`,
    );
  }
  const parent = tryGit(cwd, "rev-parse", `${latest}^`);
  if (recorded === latest || (parent !== null && recorded === parent)) {
    return { boundary: String(recorded) };
  }
  if (isAncestor(cwd, latest, String(recorded)) && isAncestor(cwd, String(recorded), "HEAD")) {
    throw new Error(
      `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, NEWER than ` +
        `${latest}, the newest release merge whose subject matches ${RELEASE_SUBJECT}: either a ` +
        `newer release merge's subject stopped matching (investigate RELEASE_SUBJECT) or the ` +
        `boundary was edited by hand. It must not be rolled back to ${parent ?? latest}.`,
    );
  }
  throw new Error(
    `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, but the newest release ` +
      `merge on main is ${latest} (parent ${parent}); release PR refreshes would be computed ` +
      `from a stale boundary. Fix by PR: set last-release-sha to ${parent ?? latest}.`,
  );
}

/** merge-base fails outright on a sha this checkout lacks, so unknown ones are screened into a plain "no" first. */
function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return (
    [ancestor, descendant].every((sha) =>
      gitYesNo(cwd, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`),
    ) && gitYesNo(cwd, "merge-base", "--is-ancestor", ancestor, descendant)
  );
}

/**
 * The PR-side half of the boundary tripwire, run on the release PR's own
 * checkout: the merge must land the anchor, and the managed
 * release-freshness gate only proves the PR contains main's tip, not that
 * the anchor commit survived (a release-please force-push wipes it until
 * the anchor workflow re-applies it). Requiring last-release-sha to equal
 * origin's CURRENT main tip makes an unanchored release PR unmergeable
 * instead of parking the pipeline after its merge.
 */
export function anchorCheck(cwd: string): { boundary: string } {
  const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8")) as {
    "last-release-sha"?: unknown;
  };
  const recorded = config["last-release-sha"];
  const tip = git(cwd, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
  if (recorded !== tip) {
    throw new Error(
      `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, but main's tip is ` +
        `${tip ?? "?"}; the anchor is missing or stale, so merging would land a wrong boundary. ` +
        `The release pipeline's update-release-pr hook re-applies it on every release-PR refresh ` +
        `- wait for (or dispatch) the next green main run, then close/reopen the PR so its ` +
        `checks run on the anchored head (the anchor is pushed with the default token, which ` +
        `triggers no new checks).`,
    );
  }
  return { boundary: String(recorded) };
}

export interface AdvanceLatestOptions {
  cwd: string;
  /** The green main commit this run judged; the checkout must be at it with the bundle built. */
  sourceSha: string;
  /** Provenance trailer for the packaged commit (the workflow run URL). */
  runUrl?: string;
  attempts?: number;
}

export interface AdvanceLatestResult {
  changed: boolean;
  latestSha: string;
  reason: string;
}

/**
 * Append the packaged child of a green main commit to refs/heads/latest.
 * Every tip on that branch is sourceSha's tree plus the bundle and names
 * its source in a Source trailer, so the branch is a chain of packaged
 * commits whose sources walk forward along main: the next tip is parented
 * on the current one and pushed WITHOUT force, so latest can only advance.
 * No tip is trusted on its trailer alone: before one is verified, left, or
 * built on, its tree must be its Source plus the bundle and nothing else,
 * and a tip of THIS source must carry the very tree this checkout's build
 * packages. A rerun on the same source then pushes nothing; a rerun of an
 * older commit's run finds latest already past it and leaves it; a tip
 * whose source is off main's history (a hand push) stops the run instead of
 * being built on. Needs the full history: whether the recorded source lies
 * behind sourceSha cannot be judged on a shallow checkout.
 */
export function advanceLatest(options: AdvanceLatestOptions): AdvanceLatestResult {
  const { cwd, sourceSha, runUrl, attempts = 3 } = options;
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      "advance-latest needs the full history (fetch-depth: 0) and this checkout is shallow: whether latest's recorded source lies on this commit's history cannot be judged on a truncated one.",
    );
  }
  const tree = packagedTree(cwd, sourceSha);
  const trailers = [`Source: ${sourceSha}`];
  if (runUrl !== undefined) {
    trailers.push(`Workflow-run: ${runUrl}`);
  }
  const subject = `build(latest): main at ${git(cwd, "rev-parse", "--short", sourceSha)}`;
  const byHand = "refusing to build on a latest this pipeline did not mint - inspect it by hand.";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let parent = sourceSha;
    // A standalone git() propagates a failing ls-remote, so a transport
    // error cannot read as "latest does not exist yet".
    if (git(cwd, "ls-remote", "origin", LATEST_REF) !== "") {
      // Depth 1: only the tip's tree and message matter, never the chain
      // of earlier bundles behind it.
      git(cwd, "fetch", "--quiet", "--depth=1", "origin", LATEST_REF);
      const tip = git(cwd, "rev-parse", "FETCH_HEAD");
      // The tip's source may be a main commit newer than this checkout
      // knows (a stale rerun, or a push race lost to a newer run), and the
      // Source trailer is no ancestry edge git could follow. Refresh main
      // AFTER reading the tip (a commit landing between the two fetches
      // then postdates the tip, not the refresh), and keep main's head:
      // "already past" is granted only to a source that is ON main.
      git(cwd, "fetch", "--quiet", "origin", "refs/heads/main");
      const mainHead = git(cwd, "rev-parse", "FETCH_HEAD");
      const tipSource = git(cwd, "log", "-1", "--format=%(trailers:key=Source,valueonly)", tip);
      if (tipSource === "") {
        throw new Error(
          `${LATEST_REF} is at ${tip}, which carries no Source trailer, so this pipeline did not mint it; ${byHand}`,
        );
      }
      const tipRef = `${LATEST_REF} is at ${tip}, which names ${tipSource} as its source but`;
      if (tipSource === sourceSha) {
        assertPackages(cwd, tip, sourceSha, tipRef, byHand);
        const tipTree = git(cwd, "rev-parse", `${tip}^{tree}`);
        if (tipTree !== tree) {
          throw new Error(
            `${tipRef} its tree ${tipTree} is not the tree ${tree} this checkout's build of ${sourceSha} packages, so the two differ in their ${BUNDLE_FILE} entry (bytes or file mode): either the tip was not built from this source or the build is not reproducible, and the Source trailer cannot tell those apart. Diff the two trees by hand; a hand-pushed tip is left for the next green push to bury (the ruleset on latest forbids moving it back), a build that differs between runs is fixed before latest can be trusted.`,
          );
        }
        return {
          changed: false,
          latestSha: tip,
          reason: `${LATEST_REF} already packages ${sourceSha} at ${tip}`,
        };
      }
      if (!isAncestor(cwd, tipSource, sourceSha)) {
        if (isAncestor(cwd, sourceSha, tipSource) && isAncestor(cwd, tipSource, mainHead)) {
          assertPackages(cwd, tip, tipSource, tipRef, byHand);
          return {
            changed: false,
            latestSha: tip,
            reason: `${LATEST_REF} is already past ${sourceSha} (built from ${tipSource}); the newer run advanced it`,
          };
        }
        throw new Error(
          `${LATEST_REF} is at ${tip}, built from ${tipSource}, which is not on main's history at ${sourceSha}; refusing to append to a latest this pipeline did not advance - inspect it by hand.`,
        );
      }
      assertPackages(cwd, tip, tipSource, tipRef, byHand);
      parent = tip;
    }
    const latestSha = commitPackaged(cwd, tree, parent, [subject, trailers.join("\n")]);
    try {
      git(cwd, "push", "origin", `${latestSha}:${LATEST_REF}`);
      return { changed: true, latestSha, reason: `${LATEST_REF}: advanced to ${latestSha}` };
    } catch (error) {
      // Another run appended in between; re-evaluate on the new tip.
      console.error(`latest push attempt ${attempt}/${attempts} lost: ${String(error)}`);
    }
  }
  throw new Error(
    `could not advance ${LATEST_REF} after ${attempts} attempts; something keeps moving it concurrently - rerun this job once it settles.`,
  );
}

if (import.meta.main) {
  const cwd = process.cwd();
  const [command] = process.argv.slice(2);
  const env = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} is required for "${command}"`);
    }
    return value;
  };
  try {
    switch (command) {
      case "package": {
        const result = packageRelease({
          cwd,
          tag: env("TAG"),
          sourceSha: env("GITHUB_SHA"),
          runUrl: process.env.RUN_URL,
        });
        console.error(
          result.created
            ? `created ${env("TAG")} on packaged commit ${result.packagedSha}`
            : `${env("TAG")} already packages this source at ${result.packagedSha}`,
        );
        break;
      }
      case "retag-major": {
        const result = retagMajor({ cwd, tag: env("TAG"), sourceSha: env("GITHUB_SHA") });
        console.error(`moved ${result.major} to ${result.packagedSha}`);
        break;
      }
      case "verify": {
        const result = verifyPublishedRefs({ cwd, tag: env("TAG"), sourceSha: env("GITHUB_SHA") });
        console.error(
          `origin's ${env("TAG")} and ${result.major} both point at packaged commit ${result.packagedSha}, whose tree carries lib/index.js`,
        );
        break;
      }
      case "anchor": {
        const result = anchorReleasePr({ cwd, sourceSha: env("GITHUB_SHA") });
        console.error(result.reason);
        break;
      }
      case "boundary-check": {
        const result = boundaryCheck(cwd);
        console.error(`boundary is fresh: ${result.boundary}`);
        break;
      }
      case "anchor-check": {
        const result = anchorCheck(cwd);
        console.error(`the release PR carries this cycle's anchor: ${result.boundary}`);
        break;
      }
      case "advance-latest": {
        const result = advanceLatest({
          cwd,
          sourceSha: env("GITHUB_SHA"),
          runUrl: process.env.RUN_URL,
        });
        console.error(result.reason);
        break;
      }
      default:
        throw new Error(
          `unknown command ${JSON.stringify(command ?? null)}; expected package | retag-major | verify | anchor | boundary-check | anchor-check | advance-latest`,
        );
    }
  } catch (error) {
    console.error(
      `release-pipeline ${command ?? ""}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
