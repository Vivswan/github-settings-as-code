/**
 * The release pipeline's git topology, called step by step from the
 * repo-owned workflows (update-release.yml for the release chain, checks.yml
 * and update-release-pr.yml for the bookkeeping, post-green.yml for the
 * build branch) and unit-tested against fixture repositories
 * (test/scripts/release-pipeline.test.ts), so "the next release tags the
 * right commits" is proven on every push.
 *
 * The scheme: main is source-only, and every ref a consumer can name points
 * at a packaged commit - a source commit's tree without its workflows, plus
 * the built lib/index.js, and nothing else - on the `build` branch. Every green push to main appends
 * one packaged commit to refs/heads/build (parent: the previous tip; the
 * first commit's parent is its source), each naming its source in a Source
 * trailer. The `latest` tag follows build's tip; the vX.Y.Z release tags and
 * the moving major vX sit on the chain commit whose source is the release's
 * merge commit. release-please cuts the DRAFT release itself (no tag: the
 * config sets `draft` without `force-tag-creation`); these subcommands then
 * run, one per workflow step:
 *   package         packageRelease: tag the release's chain commit ONCE
 *                   (appending it when post-green has not) and move latest
 *                   there, or byte-verify an existing tag. No path moves a
 *                   version tag.
 *   retag-major     retagMajor: force-move the major tag, never backward.
 *   verify          verifyPublishedRefs: origin's actual refs and tree.
 *   anchor          anchorReleasePr: advance last-release-sha on the
 *                   release PR branch (version tags live off main, so
 *                   release-please's boundary is recorded config).
 *   boundary-check  boundaryCheck: main's recorded boundary is fresh.
 *   anchor-check    anchorCheck: the release PR carries the anchor.
 *   advance-build   advanceBuild: append a green commit's packaged child to
 *                   build and move latest to the tip.
 * Env: TAG and GITHUB_SHA (package/retag-major/anchor), GITHUB_SHA
 * (advance-build), RUN_URL (optional provenance, package/advance-build).
 * Node builtins only: `bun` runs it pre-install.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILE = ".release-please-manifest.json";
const CONFIG_FILE = "release-please-config.json";
const BUNDLE_FILE = "lib/index.js";
/** Left out of every chain commit: GitHub refuses a push that creates or
 * updates a workflow file on a branch to any token without the workflows
 * grant (judged per push, against the ref's previous tip), and consumers run
 * the action, not this repository's workflows. With none on the chain, a
 * GITHUB_TOKEN with contents: write can push every chain commit, and no
 * workflow can trigger on the build branch. */
const WORKFLOWS_DIR = ".github/workflows";
const BUILD_REF = "refs/heads/build";
const LATEST_REF = "refs/tags/latest";
/** How far back along build a source's chain commit is looked for, one
 * fetched commit per step. The release job runs right after post-green in
 * the same workflow run, so a release's chain commit is the tip or a few
 * commits behind it; a source deeper than this is appended again rather
 * than found. */
const CHAIN_WALK = 50;
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

/** The server's compare-and-set diagnostic: the ref is at another value than
 * advertised, or was created since. */
const LOCK_LOST =
  "cannot lock ref '[^']+': (?:is at [0-9a-f]+ but expected [0-9a-f]+|reference already exists)";
/** git's words for the one push failure a retry can win: the remote ref moved
 * after this run observed it. Either the client saw it (the `[rejected]` status
 * line: a plain push no longer a fast-forward, a lease whose expected value went
 * stale) or the server did between advertising the ref and updating it (GitHub
 * puts its diagnostic in the status line, stock git on a `remote: error:` line
 * above the rejection). Each form is anchored to its own line shape, so a hook
 * message quoting the same words on any other line cannot match, and the
 * `[remote rejected]` line a hook or ruleset produces matches none. */
const OVERTAKEN_PUSH = new RegExp(
  [
    String.raw`^\s*!\s+\[rejected\]\s.*\((?:fetch first|non-fast-forward|stale info)\)\s*$`,
    String.raw`^remote: error: ${LOCK_LOST}\s*$`,
    String.raw`^\s*!\s+\[remote rejected\]\s.*\(${LOCK_LOST}\)\s*$`,
  ].join("|"),
  "m",
);

/**
 * Push, telling the one failure worth retrying apart from every other, and
 * deciding that HERE from git's stderr so no caller matches strings itself.
 * Overtaken (another writer moved the ref after this run observed it) is
 * returned with the stderr; a token without write access, a ruleset or
 * protected-ref decline, a transport error, and anything else are permanent
 * and thrown unchanged, git's stderr in the message.
 */
function pushUnlessOvertaken(
  cwd: string,
  ...pushArgs: string[]
): { landed: true } | { landed: false; stderr: string } {
  const args = ["push", ...pushArgs];
  try {
    execFileSync("git", args, { cwd, encoding: "utf8" });
    return { landed: true };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && OVERTAKEN_PUSH.test(stderr)) {
      return { landed: false, stderr: stderr.trim() };
    }
    throw gitFailure(args, error);
  }
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

/** The identity the pipeline's own commits (chain commits, anchor) carry. */
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
 * push), rerun verification, the major move, and the build advance.
 * Returns the entry so a caller can rebuild the tree it belongs in.
 */
function assertCarriesBundle(cwd: string, treeish: string): { mode: string; blob: string } {
  // ls-tree answers a missing path with empty output and exit 0; a failing
  // call (an object this checkout lacks, a transport error) must propagate,
  // never read as "no bundle".
  const entry = git(cwd, "ls-tree", "-l", treeish, "--", BUNDLE_FILE);
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
 * The two shapes of packaged commit. `chain`: a commit on build - the source
 * tree WITHOUT its workflows directory, plus the bundle, the source in a
 * Source trailer. `legacy`: the detached children the releases before the
 * build branch tagged (v2.0.0 and earlier) - the whole source tree plus the
 * bundle, the source on a `source:` body line. A shape is read off the
 * commit's message, never guessed from its tree.
 */
type PackageShape = "chain" | "legacy";

/**
 * sourceSha's tree, minus the workflows directory for the chain shape, plus
 * whatever `addBundle` stages at BUNDLE_FILE, and nothing else: assembled in
 * a private index read from sourceSha's tree, so no other path can enter it
 * and the checkout's own index stays untouched.
 */
function treePlusBundle(
  cwd: string,
  sourceSha: string,
  shape: PackageShape,
  addBundle: (env: Record<string, string>) => void,
): string {
  const indexFile = join(git(cwd, "rev-parse", "--absolute-git-dir"), "release-pipeline.index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    gitWithEnv(cwd, env, "read-tree", sourceSha);
    if (shape === "chain") {
      // -f: the private index carries no stat data, so without it git would
      // hold the entries against the worktree and refuse
      gitWithEnv(
        cwd,
        env,
        "rm",
        "-r",
        "-q",
        "-f",
        "--cached",
        "--ignore-unmatch",
        "--",
        WORKFLOWS_DIR,
      );
    }
    addBundle(env);
    return gitWithEnv(cwd, env, "write-tree");
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/** Paths under the workflows directory in a tree; a chain-shaped tree must have none. */
function workflowPaths(cwd: string, treeish: string): string[] {
  return git(cwd, "ls-tree", "-r", "--name-only", treeish, "--", WORKFLOWS_DIR)
    .split("\n")
    .filter((path) => path !== "");
}

/**
 * The one definition of "packaged is source's package", asserted wherever a
 * ref that already exists is blessed (a tagged rerun, the major move, every
 * build tip): packaged's tree IS the tree rebuilt from source in the
 * commit's shape plus packaged's own bundle entry. Tree identity, not a
 * path diff: a diff lists paths, so an extra empty subtree or a rename
 * hides from it, while no tree object hides from its own id. `remedy`
 * tells the operator what to do.
 */
function assertPackages(
  cwd: string,
  packaged: string,
  source: string,
  shape: PackageShape,
  ref: string,
  remedy: string,
): void {
  const { mode, blob } = assertCarriesBundle(cwd, packaged);
  const expected = treePlusBundle(cwd, source, shape, (env) =>
    gitWithEnv(cwd, env, "update-index", "--add", "--cacheinfo", `${mode},${blob},${BUNDLE_FILE}`),
  );
  const actual = git(cwd, "rev-parse", `${packaged}^{tree}`);
  if (actual !== expected) {
    const expectedPaths =
      shape === "chain" ? `${BUNDLE_FILE} and the removal of ${WORKFLOWS_DIR}/` : BUNDLE_FILE;
    // A chain commit's diff against its source lists the workflow removals
    // it is supposed to carry; what it must not carry is a workflow KEPT,
    // which an identical file never shows in a diff, so those are listed
    // from its tree instead.
    const changed = git(cwd, "diff", "--no-renames", "--name-only", source, packaged)
      .split("\n")
      .filter(
        (path) =>
          path !== "" &&
          path !== BUNDLE_FILE &&
          !(shape === "chain" && path.startsWith(`${WORKFLOWS_DIR}/`)),
      )
      .concat(
        shape === "chain" ? workflowPaths(cwd, packaged).map((path) => `${path} (kept)`) : [],
      );
    const listed =
      changed.length === 0
        ? "none (an entry a path diff cannot list, such as an empty subtree)"
        : changed.join(", ");
    throw new Error(
      `${ref} is not ${source} plus ${expectedPaths} alone: its tree is ${actual}, the rebuilt one is ${expected} (paths beyond those changed relative to ${source}: ${listed}); ${remedy}`,
    );
  }
}

/**
 * The tree every chain commit carries: sourceSha's tree without its
 * workflows plus the bundle built in the checkout. The checkout must BE
 * sourceSha with a clean worktree: that is what makes the bundle a build of
 * that source rather than of a by-hand edit (the bundle itself is gitignored
 * and never shows as pending).
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
  const tree = treePlusBundle(cwd, sourceSha, "chain", (env) =>
    gitWithEnv(cwd, env, "add", "-f", BUNDLE_FILE),
  );
  assertCarriesBundle(cwd, tree);
  const leaked = workflowPaths(cwd, tree);
  if (leaked.length > 0) {
    throw new Error(
      `the packaged tree ${tree} still carries ${leaked.join(", ")}; a chain commit must carry no ${WORKFLOWS_DIR}/ (GitHub refuses the push to any token without the workflows grant, and consumers run the action, not the workflows).`,
    );
  }
  return tree;
}

/** The Source trailer as git parses it (empty when the commit has none). */
function sourceTrailer(cwd: string, sha: string): string {
  return git(cwd, "log", "-1", "--format=%(trailers:key=Source,valueonly)", sha);
}

/**
 * The source a packaged commit records, and the shape that record implies:
 * a Source trailer makes it a chain commit, a `source:` body line one of the
 * detached children the releases before the build branch tagged. Null when
 * the commit records neither.
 */
function recordedSource(cwd: string, sha: string): { source: string; shape: PackageShape } | null {
  const trailer = sourceTrailer(cwd, sha);
  if (trailer !== "") {
    return { source: trailer, shape: "chain" };
  }
  const body = git(cwd, "log", "-1", "--format=%B", sha);
  const line = body.match(/^source: ([0-9a-f]{40})$/m)?.[1];
  return line === undefined ? null : { source: line, shape: "legacy" };
}

/** The one shape of chain commit: `tree` under the pipeline's identity, the
 * source named in a Source trailer (the provenance trailer beside it). */
function commitChain(
  cwd: string,
  tree: string,
  parent: string,
  sourceSha: string,
  runUrl: string | undefined,
): string {
  configureIdentity(cwd);
  const trailers = [`Source: ${sourceSha}`];
  if (runUrl !== undefined) {
    trailers.push(`Workflow-run: ${runUrl}`);
  }
  const subject = `build: main at ${git(cwd, "rev-parse", "--short", sourceSha)}`;
  return git(cwd, "commit-tree", "-p", parent, "-m", subject, "-m", trailers.join("\n"), tree);
}

/** Origin's build tip and main head, read together. */
interface BuildTip {
  /** build's tip, or null while the branch does not exist. */
  tip: string | null;
  /** origin's main, read AFTER the tip: a commit landing between the two
   * reads then postdates the tip, not the refresh. */
  mainHead: string;
}

/**
 * Fetch build's tip alone (depth 1: only its tree and message matter here,
 * never the chain of earlier bundles behind it) and refresh main. The tip's
 * source may be a main commit newer than this checkout knows (a stale
 * rerun, or a push race lost to a newer run), and the Source trailer is no
 * ancestry edge git could follow, so main's head is kept: "on main" is
 * granted only to a source that is reachable from it.
 */
function readBuildTip(cwd: string): BuildTip {
  // A standalone git() propagates a failing ls-remote, so a transport
  // error cannot read as "build does not exist yet".
  let tip: string | null = null;
  if (git(cwd, "ls-remote", "origin", BUILD_REF) !== "") {
    git(cwd, "fetch", "--quiet", "--depth=1", "origin", BUILD_REF);
    tip = git(cwd, "rev-parse", "FETCH_HEAD");
  }
  git(cwd, "fetch", "--quiet", "origin", "refs/heads/main");
  return { tip, mainHead: git(cwd, "rev-parse", "FETCH_HEAD") };
}

/** Where a chain walk stopped without a match: at the chain's end (the
 * root, whose parent is on main, or a commit without a Source trailer, not
 * this pipeline's) or at the CHAIN_WALK bound, with the chain unread beyond. */
type WalkEnd = { found: string } | { ended: true } | { exhausted: true };

/**
 * Walk build from the tip, one commit at a time, each fetched by sha at
 * depth 1 only when this checkout lacks it: a depth-N fetch of build would
 * mark main commits shallow whenever the chain is shorter than N, and a
 * shallow main falsifies every ancestry verdict below. Returns the first
 * commit `wanted` accepts, or how the walk stopped: a caller that needs
 * "not on the chain" gets it only from an ENDED walk, never from the bound.
 */
function walkChain(
  cwd: string,
  tip: string,
  mainHead: string,
  wanted: (commit: string, source: string) => boolean,
): WalkEnd {
  let commit: string | null = tip;
  for (let step = 0; step < CHAIN_WALK; step++) {
    if (commit === null) {
      return { ended: true };
    }
    const source = sourceTrailer(cwd, commit);
    if (source === "") {
      return { ended: true };
    }
    if (wanted(commit, source)) {
      return { found: commit };
    }
    commit = chainParent(cwd, commit, mainHead);
  }
  return commit === null ? { ended: true } : { exhausted: true };
}

/** The chain commit whose Source is sourceSha, or null when none is within the walk. */
function findPackaged(
  cwd: string,
  tip: string,
  sourceSha: string,
  mainHead: string,
): string | null {
  const walk = walkChain(cwd, tip, mainHead, (_commit, source) => source === sourceSha);
  return "found" in walk ? walk.found : null;
}

/** `commit`'s parent as its object records it (a depth-1 fetch grafts the
 * parent edge away, so rev-parse cannot answer), fetched when unknown here;
 * null once the parent lies on main, which is where the chain ends. */
function chainParent(cwd: string, commit: string, mainHead: string): string | null {
  const parent = git(cwd, "cat-file", "-p", commit).match(/^parent ([0-9a-f]{40})$/m)?.[1];
  if (parent === undefined) {
    return null;
  }
  if (!gitYesNo(cwd, "rev-parse", "--verify", "--quiet", `${parent}^{commit}`)) {
    git(cwd, "fetch", "--quiet", "--depth=1", "origin", parent);
  }
  return isAncestor(cwd, parent, mainHead) ? null : parent;
}

const BY_HAND =
  "refusing to build on a build branch this pipeline did not mint - inspect it by hand.";

/**
 * No tip is trusted on its trailer alone: before one is built on, left, or
 * pointed at by latest, it must name a source on main's history and its
 * tree must be that source's package in the chain shape (minus workflows,
 * plus the bundle) and nothing else. Returns the tip's source.
 */
function validateTip(cwd: string, tip: string, mainHead: string): string {
  const tipSource = sourceTrailer(cwd, tip);
  if (tipSource === "") {
    throw new Error(
      `${BUILD_REF} is at ${tip}, which carries no Source trailer, so this pipeline did not mint it; ${BY_HAND}`,
    );
  }
  if (!isAncestor(cwd, tipSource, mainHead)) {
    throw new Error(
      `${BUILD_REF} is at ${tip}, built from ${tipSource}, which is not on main's history; refusing to append to a build branch this pipeline did not advance - inspect it by hand.`,
    );
  }
  assertPackages(
    cwd,
    tip,
    tipSource,
    "chain",
    `${BUILD_REF} is at ${tip}, which names ${tipSource} as its source but`,
    BY_HAND,
  );
  return tipSource;
}

/**
 * A chain commit that names this source must carry the very tree this
 * checkout's build packages: the Source trailer cannot tell a tip that was
 * not built from this source from a build that is not reproducible.
 */
function assertSameBuild(cwd: string, packaged: string, sourceSha: string, tree: string): void {
  assertPackages(
    cwd,
    packaged,
    sourceSha,
    "chain",
    `${BUILD_REF} holds ${packaged}, which names ${sourceSha} as its source but`,
    BY_HAND,
  );
  const packagedTree = git(cwd, "rev-parse", `${packaged}^{tree}`);
  if (packagedTree !== tree) {
    throw new Error(
      `${BUILD_REF} holds ${packaged}, which names ${sourceSha} as its source but its tree ${packagedTree} is not the tree ${tree} this checkout's build of ${sourceSha} packages, so the two differ in their ${BUNDLE_FILE} entry (bytes or file mode): either the commit was not built from this source or the build is not reproducible, and the Source trailer cannot tell those apart. Diff the two trees by hand; a hand-pushed commit is left for the next green push to bury (the ruleset on build forbids moving it back), a build that differs between runs is fixed before build can be trusted.`,
    );
  }
}

/**
 * Append `tree`, sourceSha's package, to build after the validated tip,
 * with a plain fast-forward push: git's compare-and-set is the concurrency
 * control, so an overtaken push (another run appended first) is reported
 * for the caller to re-read the chain and decide again, and every other
 * failure is thrown as git worded it.
 */
function appendChain(
  cwd: string,
  build: BuildTip,
  sourceSha: string,
  tree: string,
  runUrl: string | undefined,
): { sha: string } | { overtaken: string } {
  let parent = sourceSha;
  if (build.tip !== null) {
    validateTip(cwd, build.tip, build.mainHead);
    parent = build.tip;
  }
  const sha = commitChain(cwd, tree, parent, sourceSha, runUrl);
  const push = pushUnlessOvertaken(cwd, "origin", `${sha}:${BUILD_REF}`);
  return push.landed ? { sha } : { overtaken: push.stderr };
}

export interface PackageOptions {
  cwd: string;
  tag: string;
  /** The release-please merge commit this run tested; the tag's recorded source. */
  sourceSha: string;
  /** Provenance trailer for a chain commit this run has to append (the workflow run URL). */
  runUrl?: string;
}

export interface PackagedRelease {
  created: boolean;
  packagedSha: string;
  /** Where refs/tags/latest points after this run; null only when the tag
   * verified is a legacy detached commit, which latest never names. */
  latestSha: string | null;
}

/**
 * Create the release's version tag on its chain commit, exactly once. The
 * worktree must be the merge commit with the bundle freshly built. The
 * chain commit is normally build's tip (post-green appended it in the same
 * workflow run, before this job) and is found by its Source trailer; when
 * none packages this source (post-green skipped for want of its token, or
 * its append never landed) it is appended here through the same path
 * post-green uses, and an overtaken append re-walks: the rival's commit is
 * tagged when it packages this source, built on otherwise. Once the tag is
 * on, refs/tags/latest is moved the way post-green moves it (to the chain
 * commit packaging the newest source, never back over a newer one), so
 * @latest exists from the first release on even where post-green cannot
 * push. A rerun finds the tag on origin and byte-verifies it instead
 * (recorded source, whole tree, bundle bytes), so no rerun can move or
 * replace a version tag - a mismatch is a loud stop - and then reconciles
 * latest the same way, so a run that died between the tag push and the
 * latest move is healed by its rerun.
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
    // Depth 1: the tag's commit alone. A deeper fetch into this full clone
    // would mark the merge commit shallow and cut main's ancestry behind it,
    // which the latest move below then misjudges.
    git(cwd, "fetch", "--quiet", "--depth=1", "origin", `+${ref}:${ref}`);
    const verified = verifyPackagedTag(cwd, tag, sourceSha);
    if (verified.shape === "legacy") {
      return { created: false, packagedSha: verified.sha, latestSha: null };
    }
    const latest = publishLatest(cwd, verified.sha, 3);
    console.error(latest.reason);
    return { created: false, packagedSha: verified.sha, latestSha: latest.sha };
  }
  const attempts = 3;
  let packagedSha: string | null = null;
  for (let attempt = 1; attempt <= attempts && packagedSha === null; attempt++) {
    const build = readBuildTip(cwd);
    const found =
      build.tip === null ? null : findPackaged(cwd, build.tip, sourceSha, build.mainHead);
    if (found !== null) {
      assertSameBuild(cwd, found, sourceSha, tree);
      packagedSha = found;
      break;
    }
    const appended = appendChain(cwd, build, sourceSha, tree, runUrl);
    if ("sha" in appended) {
      packagedSha = appended.sha;
      break;
    }
    // Another run appended in between; re-read the chain, it may now hold this source.
    console.error(`build push attempt ${attempt}/${attempts} overtaken: ${appended.overtaken}`);
  }
  if (packagedSha === null) {
    throw new Error(
      `could not append ${sourceSha}'s package to ${BUILD_REF} after ${attempts} attempts; something keeps moving it concurrently - rerun this job once it settles.`,
    );
  }
  git(cwd, "tag", tag, packagedSha);
  git(cwd, "push", "origin", ref);
  const latest = publishLatest(cwd, packagedSha, attempts);
  console.error(latest.reason);
  return { created: true, packagedSha, latestSha: latest.sha };
}

/**
 * Prove an existing version tag is THIS source's package: it records the
 * merge commit as its source, its tree is that source's package in the
 * shape its record implies (chain: minus workflows plus the bundle; legacy:
 * plus the bundle; a planted commit that keeps the expected bundle but
 * edits action.yml fails either way), and it carries exactly the bytes the
 * fresh build in the worktree produced. Returns the commit and its shape.
 */
function verifyPackagedTag(
  cwd: string,
  tag: string,
  sourceSha: string,
): { sha: string; shape: PackageShape } {
  const frozen =
    "the release-tags ruleset freezes version tags, so no rerun can replace it - inspect it by hand.";
  const packagedSha = git(cwd, "rev-parse", `refs/tags/${tag}^{}`);
  const recorded = recordedSource(cwd, packagedSha);
  if (recorded?.source !== sourceSha) {
    throw new Error(
      `refs/tags/${tag} exists but records ${recorded === null ? "no source" : `${recorded.source} as its source`}, not this release's merge commit ${sourceSha}; ${frozen}`,
    );
  }
  assertPackages(
    cwd,
    packagedSha,
    sourceSha,
    recorded.shape,
    `refs/tags/${tag} (${packagedSha})`,
    frozen,
  );
  const tagged = gitBytes(cwd, "show", `${packagedSha}:${BUNDLE_FILE}`);
  if (!tagged.equals(readFileSync(join(cwd, BUNDLE_FILE)))) {
    throw new Error(
      `refs/tags/${tag} carries a ${BUNDLE_FILE} that is not a build of ${sourceSha}'s source; ${frozen}`,
    );
  }
  return { sha: packagedSha, shape: recorded.shape };
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
 * between the newest-check and the push; an overtaken lease re-evaluates,
 * any other failure is thrown as git worded it.
 */
export function retagMajor(options: RetagMajorOptions): { major: string; packagedSha: string } {
  const { cwd, tag, sourceSha } = options;
  const ref = `refs/tags/${tag}`;
  git(cwd, "fetch", "--quiet", "--depth=1", "origin", `+${ref}:${ref}`);
  // The full packaged-tag verification (recorded source, whole tree, bundle
  // bytes), not a weaker probe: the major must never bless a commit a fresh
  // package run would refuse, however this command was reached.
  const packagedSha = verifyPackagedTag(cwd, tag, sourceSha).sha;
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
    const push = pushUnlessOvertaken(
      cwd,
      `--force-with-lease=refs/tags/${major}:${observed}`,
      "origin",
      `refs/tags/${major}`,
    );
    if (push.landed) {
      return { major, packagedSha };
    }
    console.error(`major lease push attempt ${attempt}/${attempts} overtaken: ${push.stderr}`);
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
 * version tag and its major - must point at a packaged commit recording
 * this release's merge commit as its source, and that commit's tree must
 * be the merge commit's package in the shape its record implies and
 * nothing else.
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
    "--depth=1",
    "origin",
    `+refs/tags/${tag}:refs/verify/${tag}`,
    `+refs/tags/${major}:refs/verify/${major}`,
  );
  const packagedSha = git(cwd, "rev-parse", `refs/verify/${tag}^{}`);
  const recorded = recordedSource(cwd, packagedSha);
  if (recorded?.source !== sourceSha) {
    throw new Error(
      `origin's refs/tags/${tag} points at ${packagedSha}, which records ${recorded === null ? "no source" : `${recorded.source} as its source`}, not this release's merge commit ${sourceSha}.`,
    );
  }
  // The verify job's checkout is main's head at depth 1; the merge commit's
  // tree comes from origin by sha so the whole-tree check can run here too.
  git(cwd, "fetch", "--quiet", "--depth=1", "origin", sourceSha);
  assertPackages(
    cwd,
    packagedSha,
    sourceSha,
    recorded.shape,
    `origin's refs/tags/${tag} (${packagedSha})`,
    "the release-tags ruleset freezes version tags, so no rerun can replace it - inspect it by hand.",
  );
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
    // Detached on FETCH_HEAD, never a local branch: a retry after an
    // overtaken push must re-fetch, and git refuses to fetch into a
    // checked-out ref.
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
      "last-release-sha records the merge parent so the squash merge itself lands the next cycle's boundary on main: version tags live on packaged commits that are not on main, so release-please cannot find the boundary by tag.",
    );
    // Recheck main immediately before pushing: the fetch above can lose a
    // race where a newer push's run already refreshed and anchored the
    // branch - this run's commit would descend from that anchor and push
    // cleanly, regressing the boundary to the older head.
    const headNow = git(cwd, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
    if (headNow !== sourceSha) {
      return { changed: false, reason: `main moved to ${headNow ?? "?"}; the newer run anchors` };
    }
    const push = pushUnlessOvertaken(cwd, "origin", `HEAD:${branchRef}`);
    if (push.landed) {
      return { changed: true, reason: `${RELEASE_PR_BRANCH}: anchored at ${sourceSha}` };
    }
    // release-please force-pushed a refresh mid-anchor; reapply on it.
    console.error(`anchor push attempt ${attempt}/${attempts} overtaken: ${push.stderr}`);
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

export interface AdvanceBuildOptions {
  cwd: string;
  /** The green main commit this run judged; the checkout must be at it with the bundle built. */
  sourceSha: string;
  /** Provenance trailer for the chain commit (the workflow run URL). */
  runUrl?: string;
  attempts?: number;
}

export interface AdvanceBuildResult {
  /** Whether this run appended to build. */
  changed: boolean;
  /** The chain commit packaging this source, or the newer tip build was left at. */
  buildSha: string;
  /** Where refs/tags/latest points when this run ends: the chain commit
   * packaging the newest source (normally build's tip). */
  latestSha: string;
  reason: string;
}

/**
 * Append the packaged child of a green main commit to refs/heads/build and
 * move the `latest` tag to build's tip. Every commit on build is its
 * source's tree minus workflows plus the bundle and names that source in a
 * Source trailer,
 * so the branch is a chain of packaged commits whose sources walk forward
 * along main: the next commit is parented on the current tip and pushed
 * WITHOUT force, so build can only advance. A rerun on a source the chain
 * already packages pushes nothing (after checking that commit carries the
 * very tree this checkout's build packages); a rerun of an older commit's
 * run finds the tip already past it and leaves it; a tip whose source is
 * off main's history (a hand push) stops the run instead of being built on.
 * Needs the full history: whether a recorded source lies behind sourceSha
 * cannot be judged on a shallow checkout.
 */
export function advanceBuild(options: AdvanceBuildOptions): AdvanceBuildResult {
  const { cwd, sourceSha, runUrl, attempts = 3 } = options;
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      "advance-build needs the full history (fetch-depth: 0) and this checkout is shallow: whether build's recorded sources lie on this commit's history cannot be judged on a truncated one.",
    );
  }
  const tree = packagedTree(cwd, sourceSha);
  const advanced = advanceChain(cwd, sourceSha, tree, runUrl, attempts);
  const latest = publishLatest(cwd, advanced.buildSha, attempts);
  return {
    ...advanced,
    latestSha: latest.sha,
    reason: `${advanced.reason}; ${latest.reason}`,
  };
}

/** The build half of advanceBuild: the chain commit for this source, appended or found. */
function advanceChain(
  cwd: string,
  sourceSha: string,
  tree: string,
  runUrl: string | undefined,
  attempts: number,
): { changed: boolean; buildSha: string; reason: string } {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const build = readBuildTip(cwd);
    if (build.tip !== null) {
      const found = findPackaged(cwd, build.tip, sourceSha, build.mainHead);
      if (found !== null) {
        assertSameBuild(cwd, found, sourceSha, tree);
        return {
          changed: false,
          buildSha: found,
          reason: `${BUILD_REF} already packages ${sourceSha} at ${found}`,
        };
      }
      const tipSource = validateTip(cwd, build.tip, build.mainHead);
      if (!isAncestor(cwd, tipSource, sourceSha)) {
        if (!isAncestor(cwd, sourceSha, tipSource)) {
          throw new Error(
            `${BUILD_REF} is at ${build.tip}, built from ${tipSource}, which is not on main's history at ${sourceSha}; refusing to append to a build branch this pipeline did not advance - inspect it by hand.`,
          );
        }
        return {
          changed: false,
          buildSha: build.tip,
          reason: `${BUILD_REF} is already past ${sourceSha} (built from ${tipSource}); the newer run advanced it`,
        };
      }
    }
    const appended = appendChain(cwd, build, sourceSha, tree, runUrl);
    if ("sha" in appended) {
      return {
        changed: true,
        buildSha: appended.sha,
        reason: `${BUILD_REF}: advanced to ${appended.sha}`,
      };
    }
    // Another run appended in between; re-evaluate on the new tip.
    console.error(`build push attempt ${attempt}/${attempts} overtaken: ${appended.overtaken}`);
  }
  throw new Error(
    `could not advance ${BUILD_REF} after ${attempts} attempts; something keeps moving it concurrently - rerun this job once it settles.`,
  );
}

/**
 * Point refs/tags/latest at the chain commit packaging the NEWEST source:
 * build's tip, unless the tip is a release the hook backfilled behind this
 * run's own commit (post-green skipped that release, newer commits landed,
 * then the release job appended it), in which case this run's commit is
 * newer. The push is a compare-and-swap on the tag value observed BEFORE
 * the tip is read: build only ever advances and latest only ever names a
 * value build has held, so a tip read after the observation is that value
 * or a newer one, and a lease that goes stale means another run moved
 * latest - re-read both and retry. A latest that already names a newer
 * source than the target, on a chain commit that checks out, stays where it
 * is (a stale rerun must not lease it back) until the next green push
 * appends past.
 */
function publishLatest(
  cwd: string,
  own: string,
  attempts: number,
): { sha: string; reason: string } {
  const ownSource = sourceTrailer(cwd, own);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const observed = git(cwd, "ls-remote", "origin", LATEST_REF).split("\t")[0] ?? "";
    const build = readBuildTip(cwd);
    if (build.tip === null) {
      throw new Error(
        `${BUILD_REF} vanished after this run appended to it; inspect origin by hand.`,
      );
    }
    const tipSource = validateTip(cwd, build.tip, build.mainHead);
    const [target, targetSource] = isAncestor(cwd, ownSource, tipSource)
      ? [build.tip, tipSource]
      : [own, ownSource];
    if (observed === target) {
      return { sha: target, reason: `${LATEST_REF} already at ${target}` };
    }
    if (observed !== "") {
      const newer = newerChainCommit(cwd, observed, targetSource, build.tip, build.mainHead);
      if (newer !== null) {
        return {
          sha: observed,
          reason: `${LATEST_REF} stays at ${observed} (built from ${newer}), newer than ${target} (built from ${targetSource}); the next green push appends past it`,
        };
      }
    }
    const push = pushUnlessOvertaken(
      cwd,
      `--force-with-lease=${LATEST_REF}:${observed}`,
      "origin",
      `${target}:${LATEST_REF}`,
    );
    if (push.landed) {
      return { sha: target, reason: `${LATEST_REF}: moved to ${target}` };
    }
    console.error(`latest lease push attempt ${attempt}/${attempts} overtaken: ${push.stderr}`);
  }
  throw new Error(
    `could not move ${LATEST_REF} after ${attempts} compare-and-swap attempts; something keeps moving it concurrently - rerun this job once it settles.`,
  );
}

/**
 * The source `observed` (what refs/tags/latest names) packages, when latest
 * must be left there: a commit ON build whose source is on main and strictly
 * newer than the target's, and whose tree is that source's chain package.
 * Null otherwise - the tag moved between the two reads, or a hand push
 * planted something with a newer Source trailer but a tampered tree or off
 * the chain - and the target takes over; the lease settles the race. A walk
 * that hits its bound before reaching the observed commit or the chain's
 * end has not shown it off the chain, so latest is left alone then too.
 */
function newerChainCommit(
  cwd: string,
  observed: string,
  targetSource: string,
  tip: string,
  mainHead: string,
): string | null {
  git(cwd, "fetch", "--quiet", "--depth=1", "origin", LATEST_REF);
  // The tag can move between the ls-remote and this fetch: then the value
  // judged here is not the value origin holds, so nothing is deferred to and
  // the lease on the observed value settles it (overtaken, re-read, retry).
  if (git(cwd, "rev-parse", "FETCH_HEAD") !== observed) {
    return null;
  }
  const source = sourceTrailer(cwd, observed);
  if (
    source === "" ||
    source === targetSource ||
    !isAncestor(cwd, source, mainHead) ||
    !isAncestor(cwd, targetSource, source)
  ) {
    return null;
  }
  if (!packages(cwd, observed, source)) {
    return null;
  }
  const walk = walkChain(cwd, tip, mainHead, (commit) => commit === observed);
  return "ended" in walk ? null : source;
}

/** assertPackages as a question, for a commit this pipeline may leave alone rather than stop on. */
function packages(cwd: string, packaged: string, source: string): boolean {
  try {
    assertPackages(cwd, packaged, source, "chain", packaged, "");
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      / is not .* plus |does not carry a non-empty/.test(error.message)
    ) {
      return false;
    }
    throw error;
  }
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
            ? `created ${env("TAG")} on chain commit ${result.packagedSha}; latest at ${result.latestSha}`
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
      case "advance-build": {
        const result = advanceBuild({
          cwd,
          sourceSha: env("GITHUB_SHA"),
          runUrl: process.env.RUN_URL,
        });
        console.error(result.reason);
        break;
      }
      default:
        throw new Error(
          `unknown command ${JSON.stringify(command ?? null)}; expected package | retag-major | verify | anchor | boundary-check | anchor-check | advance-build`,
        );
    }
  } catch (error) {
    console.error(
      `release-pipeline ${command ?? ""}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
