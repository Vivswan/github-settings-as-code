/**
 * The release pipeline's git topology. main stays source-only, no version tag ever lands on it, and every ref a
 * consumer names points at a packaged commit on the `build` branch (the tags cut before that branch existed point
 * at main commits from when main still committed the bundle).
 *
 *   packaged commit    = source tree - .github/workflows + the built lib/index.js, `Source: <sha>` trailer
 *   refs/heads/build   root (no parent) -> chain commit -> chain commit ...   only ever advances
 *   refs/tags/latest   -> the newest source among build's tip, the publishing run's own chain commit, and where latest already points
 *   refs/tags/vX.Y.Z   -> the chain commit whose source is the release's merge commit; never moved
 *   refs/tags/vX       -> the same commit, force-moved on each release; retagMajor refuses a step backward (see its one blind race)
 *
 * release-please cuts the DRAFT release without a tag (`draft` on, `force-tag-creation` off); one subcommand runs
 * per workflow step:
 *
 *   advance-build                  post-green.yml          GITHUB_SHA, RUN_URL (optional)
 *   package, retag-major           update-release.yml      TAG, GITHUB_SHA, RUN_URL (optional, package only)
 *   verify                         update-release.yml      TAG, GITHUB_SHA
 *   anchor                         update-release-pr.yml   GITHUB_SHA
 *   boundary-check, anchor-check   checks.yml              (the checkout alone)
 *
 * Node builtins only: bun runs this before `bun install`. Fixture-repository tests: test/scripts/release-pipeline.test.ts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILE = ".release-please-manifest.json";
const CONFIG_FILE = "release-please-config.json";
const BUNDLE_FILE = "lib/index.js";
/** No chain commit carries a workflow file: GitHub judges each pushed commit's diff against its parent and refuses a
 * workflow-file change to a token without the workflows grant. Consumers run the action, not the workflows.
 *   a chain commit against its parent          -> no workflow change, so the default GITHUB_TOKEN can push it
 *   the first chain commit as its source's CHILD -> would record the workflows' deletion; hence a ROOT instead */
const WORKFLOWS_DIR = ".github/workflows";
const BUILD_REF = "refs/heads/build";
const BUILD_REMOTE = "refs/remotes/origin/build";
const LATEST_REF = "refs/tags/latest";
/** Never --depth: a depth-limited fetch marks the commit it lands on shallow, cutting its parent links in this
 * clone, and assertOnChain walks those links, so a release behind a shallow-marked latest would read as off build.
 * The bundle blob a check needs arrives on demand, or with the commit on a server without filter support. */
const TAG_FETCH = ["--filter=blob:none"];
/** A squash-merged release-please PR's subject on main. Anchored at both ends wherever release merges are recognized:
 * a prefix match would let "chore(main): release pipeline documentation" impersonate one and park the boundary check. */
const RELEASE_SUBJECT = /^chore\(main\): release (\d+\.\d+\.\d+)(?: \(#\d+\))?$/;

function git(cwd: string, ...args: string[]): string {
  return gitWithEnv(cwd, {}, ...args);
}

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

/** The server's compare-and-set diagnostic: the ref moved, or was created, after it was advertised. */
const LOCK_LOST =
  "cannot lock ref '[^']+': (?:is at [0-9a-f]+ but expected [0-9a-f]+|reference already exists)";
/** The one push failure a retry can win: the remote ref moved after this run observed it. Each form is anchored to
 * its own line shape, so a hook message quoting the same words on another line cannot match, and a
 * `[remote rejected]` line with any other reason (a hook or ruleset decline) matches none.
 *
 *   ! [rejected] ... (fetch first|non-fast-forward|stale info)   the client saw the move
 *   remote: error: cannot lock ref ...                            stock git's server-side race, on its own line
 *   ! [remote rejected] ... (cannot lock ref ...)                 GitHub's, in the status line */
const OVERTAKEN_PUSH = new RegExp(
  [
    String.raw`^\s*!\s+\[rejected\]\s.*\((?:fetch first|non-fast-forward|stale info)\)\s*$`,
    String.raw`^remote: error: ${LOCK_LOST}\s*$`,
    String.raw`^\s*!\s+\[remote rejected\]\s.*\(${LOCK_LOST}\)\s*$`,
  ].join("|"),
  "m",
);

/** The one place git's stderr is read for "overtaken", so no caller matches strings itself; every other push
 * failure (no write access, a ruleset decline, a transport error) is permanent and thrown. */
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

/** No encoding: the bundle comparison must be byte-exact. */
function gitBytes(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd });
}

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

function configureIdentity(cwd: string): void {
  git(cwd, "config", "user.name", "settings-as-code-release");
  git(cwd, "config", "user.email", "settings-as-code-release@users.noreply.github.com");
}

/** Every ref derivation passes through this parse, so a malformed tag stops the pipeline instead of minting "v2"
 * from "v2.1-rc.0". */
function releaseMajor(tag: string): string {
  const match = tag.match(/^v(\d+)\.\d+\.\d+$/);
  if (!match) {
    throw new Error(
      `tag ${JSON.stringify(tag)} is not a vX.Y.Z release tag; refusing to derive version refs from it.`,
    );
  }
  return `v${match[1]}`;
}

/** A consumable ref must carry the bundle as a non-empty REGULAR file: a symlink or a gitlink at that path has a
 * size too, and no bundle. Asserted on every path that mints or blesses a ref. */
function assertCarriesBundle(cwd: string, treeish: string): { mode: string; blob: string } {
  // ls-tree answers a missing path with empty output and exit 0; a failing call (a missing object, a transport
  // error) must propagate, never read as "no bundle".
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

/** Assembled in a private index read from sourceSha's tree, so nothing beyond that tree but the bundle can enter and
 * the checkout's own index stays untouched. */
function treePlusBundle(
  cwd: string,
  sourceSha: string,
  addBundle: (env: Record<string, string>) => void,
): string {
  const indexFile = join(git(cwd, "rev-parse", "--absolute-git-dir"), "release-pipeline.index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    gitWithEnv(cwd, env, "read-tree", sourceSha);
    // -f: the private index carries no stat data, so without it git would hold the entries against the worktree and refuse.
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
    addBundle(env);
    return gitWithEnv(cwd, env, "write-tree");
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function workflowPaths(cwd: string, treeish: string): string[] {
  return git(cwd, "ls-tree", "-r", "--name-only", treeish, "--", WORKFLOWS_DIR)
    .split("\n")
    .filter((path) => path !== "");
}

/** The one definition of "packaged is source's package", by tree identity rather than a path diff: a diff lists
 * paths, so an extra empty subtree hides from it, while no tree object hides from its own id. */
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
    // An unchanged workflow file never shows in the diff against the source, so every workflow path still in the tree is listed as kept.
    const changed = git(cwd, "diff", "--no-renames", "--name-only", source, packaged)
      .split("\n")
      .filter(
        (path) => path !== "" && path !== BUNDLE_FILE && !path.startsWith(`${WORKFLOWS_DIR}/`),
      )
      .concat(workflowPaths(cwd, packaged).map((path) => `${path} (kept)`));
    const listed =
      changed.length === 0
        ? "none (an entry a path diff cannot list, such as an empty subtree)"
        : changed.join(", ");
    throw new Error(
      `${ref} is not ${source} plus ${BUNDLE_FILE} and the removal of ${WORKFLOWS_DIR}/ alone: its tree is ${actual}, the rebuilt one is ${expected} (paths beyond those changed relative to ${source}: ${listed}); ${remedy}`,
    );
  }
}

/** The checkout must BE sourceSha with a clean worktree: that is what makes the bundle a build of that source rather
 * than of a by-hand edit. The bundle itself is gitignored, so it never shows as pending. */
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
  const leaked = workflowPaths(cwd, tree);
  if (leaked.length > 0) {
    throw new Error(
      `the packaged tree ${tree} still carries ${leaked.join(", ")}; a chain commit must carry no ${WORKFLOWS_DIR}/ (GitHub refuses the push to any token without the workflows grant, and consumers run the action, not the workflows).`,
    );
  }
  return tree;
}

function sourceTrailer(cwd: string, sha: string): string {
  return git(cwd, "log", "-1", "--format=%(trailers:key=Source,valueonly)", sha);
}

function commitChain(
  cwd: string,
  tree: string,
  parent: string | null,
  sourceSha: string,
  runUrl: string | undefined,
): string {
  configureIdentity(cwd);
  const trailers = [`Source: ${sourceSha}`];
  if (runUrl !== undefined) {
    trailers.push(`Workflow-run: ${runUrl}`);
  }
  const subject = `build: main at ${git(cwd, "rev-parse", "--short", sourceSha)}`;
  const parents = parent === null ? [] : ["-p", parent];
  return git(cwd, "commit-tree", ...parents, "-m", subject, "-m", trailers.join("\n"), tree);
}

interface BuildTip {
  tip: string | null;
  /** Read AFTER the tip, so a commit landing between the two reads postdates the tip rather than the refresh. */
  mainHead: string;
}

/** The chain is rooted, so a blobless fetch of build brings only chain commits and their trees. Main's head rides
 * along because the tip's source can be newer than this checkout knows (a stale rerun, a lost push race) and a
 * Source trailer is no ancestry edge: "on main" is granted only to a source reachable from that head. */
function readBuildTip(cwd: string): BuildTip {
  // A standalone git() propagates a failing ls-remote, so a transport error cannot read as "build does not exist yet".
  let tip: string | null = null;
  if (git(cwd, "ls-remote", "origin", BUILD_REF) !== "") {
    git(cwd, "fetch", "--quiet", "--filter=blob:none", "origin", `+${BUILD_REF}:${BUILD_REMOTE}`);
    tip = git(cwd, "rev-parse", BUILD_REMOTE);
  }
  return { tip, mainHead: fetchMainHead(cwd) };
}

/** A plain fetch does not deepen a shallow clone, so an ancestry verdict against this head holds only on a full
 * checkout: the package and advance-build jobs check out with fetch-depth 0 (advanceBuild refuses a shallow one
 * outright), and verifyPublishedRefs' depth-1 clone reads the head without judging ancestry against it. */
function fetchMainHead(cwd: string): string {
  git(cwd, "fetch", "--quiet", "origin", "refs/heads/main");
  return git(cwd, "rev-parse", "FETCH_HEAD");
}

function findPackaged(cwd: string, sourceSha: string): string | null {
  const log = git(cwd, "log", "--format=%H%x09%(trailers:key=Source,valueonly)", BUILD_REMOTE);
  for (const line of log.split("\n")) {
    const [sha, source] = line.split("\t");
    if (sha !== undefined && sha !== "" && source === sourceSha) {
      return sha;
    }
  }
  return null;
}

const BY_HAND =
  "refusing to build on a build branch this pipeline did not mint - inspect it by hand.";

/** A tip is never trusted on its Source trailer alone: a hand push can carry any trailer. */
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
    `${BUILD_REF} is at ${tip}, which names ${tipSource} as its source but`,
    BY_HAND,
  );
  return tipSource;
}

function assertSameBuild(cwd: string, packaged: string, sourceSha: string, tree: string): void {
  assertPackages(
    cwd,
    packaged,
    sourceSha,
    `${BUILD_REF} holds ${packaged}, which names ${sourceSha} as its source but`,
    BY_HAND,
  );
  const packagedTree = git(cwd, "rev-parse", `${packaged}^{tree}`);
  if (packagedTree !== tree) {
    throw new Error(
      `${BUILD_REF} holds ${packaged}, which names ${sourceSha} as its source but its tree ` +
        `${packagedTree} is not the tree ${tree} this checkout's build of ${sourceSha} packages, ` +
        `so the two differ in their ${BUNDLE_FILE} entry (bytes or file mode): either the commit ` +
        "was not built from this source or the build is not reproducible, and the Source trailer " +
        "cannot tell those apart. Diff the two trees by hand; a hand-pushed commit is left for the " +
        "next green push to bury (the ruleset on build forbids moving it back), a build that " +
        "differs between runs is fixed before build can be trusted.",
    );
  }
}

/** A plain fast-forward push is the concurrency control: git's compare-and-set rejects an overtaken append, and the
 * caller answers by re-reading the chain and deciding again. Why the first commit is a root: see WORKFLOWS_DIR. */
function appendChain(
  cwd: string,
  build: BuildTip,
  sourceSha: string,
  tree: string,
  runUrl: string | undefined,
): { sha: string } | { overtaken: string } {
  let parent: string | null = null;
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
  /** The release's merge commit, resolved from the draft (not necessarily this run's own push); the tag's recorded source. */
  sourceSha: string;
  /** Provenance trailer for a chain commit this run has to append (the workflow run URL). */
  runUrl?: string;
}

export interface PackagedRelease {
  created: boolean;
  packagedSha: string;
  /** Where refs/tags/latest points after this run. */
  latestSha: string;
}

/**
 * Mint the release's version tag on its chain commit exactly once; the checkout must be the merge commit with the
 * bundle freshly built. A rerun finds the tag on origin and byte-verifies it instead, so no rerun can move or
 * replace a version tag, then reconciles latest the same way, healing a run that died between the two pushes.
 *
 *   source off origin's main  -> stop before any push: the frozen tag and the build tip would be poisoned
 *   a chain commit packages it -> tagged (normally build's tip, appended by post-green earlier in this run)
 *   none does                  -> appended here through post-green's path; an overtaken append re-walks
 *   tag on                     -> latest moved as post-green moves it, so @latest exists even where post-green cannot push
 */
export function packageRelease(options: PackageOptions): PackagedRelease {
  const { cwd, tag, sourceSha, runUrl } = options;
  releaseMajor(tag);
  const tree = packagedTree(cwd, sourceSha);
  // A hand recovery with the wrong TAG, or a draft pointing at the wrong commit, must stop before an immutable tag is minted.
  const manifest = JSON.parse(git(cwd, "show", `HEAD:${MANIFEST_FILE}`)) as Record<string, unknown>;
  if (tag !== `v${manifest["."]}`) {
    throw new Error(
      `tag ${tag} does not match the manifest version ${JSON.stringify(manifest["."])} at ${sourceSha}; refusing to package a version this source did not release.`,
    );
  }
  const mainHead = fetchMainHead(cwd);
  if (!isAncestor(cwd, sourceSha, mainHead)) {
    throw new Error(
      `the release source ${sourceSha} is not on origin's main (its head is ${mainHead}); refusing to package, tag, or publish a commit main does not hold.`,
    );
  }
  const ref = `refs/tags/${tag}`;
  // A standalone git() propagates a failing ls-remote, so a transport error cannot read as "the tag does not exist".
  const existing = git(cwd, "ls-remote", "origin", ref);
  if (existing !== "") {
    git(cwd, "fetch", "--quiet", ...TAG_FETCH, "origin", `+${ref}:${ref}`);
    const verified = verifyPackagedTag(cwd, tag, sourceSha);
    const latest = publishLatest(cwd, verified, 3);
    console.error(latest.reason);
    return { created: false, packagedSha: verified, latestSha: latest.sha };
  }
  const attempts = 3;
  let packagedSha: string | null = null;
  for (let attempt = 1; attempt <= attempts && packagedSha === null; attempt++) {
    const build = readBuildTip(cwd);
    const found = build.tip === null ? null : findPackaged(cwd, sourceSha);
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

/** An existing tag is trusted only as THIS source's package. A planted commit that keeps the expected bundle but
 * edits action.yml fails the tree check; one whose bundle differs from the fresh build fails the byte check. */
function verifyPackagedTag(cwd: string, tag: string, sourceSha: string): string {
  const frozen =
    "the release-tags ruleset freezes version tags, so no rerun can replace it - inspect it by hand.";
  const packagedSha = git(cwd, "rev-parse", `refs/tags/${tag}^{}`);
  const source = sourceTrailer(cwd, packagedSha);
  if (source !== sourceSha) {
    throw new Error(
      `refs/tags/${tag} exists but records ${source === "" ? "no source" : `${source} as its source`}, not this release's merge commit ${sourceSha}; ${frozen}`,
    );
  }
  assertPackages(cwd, packagedSha, sourceSha, `refs/tags/${tag} (${packagedSha})`, frozen);
  const tagged = gitBytes(cwd, "show", `${packagedSha}:${BUNDLE_FILE}`);
  if (!tagged.equals(readFileSync(join(cwd, BUNDLE_FILE)))) {
    throw new Error(
      `refs/tags/${tag} carries a ${BUNDLE_FILE} that is not a build of ${sourceSha}'s source; ${frozen}`,
    );
  }
  assertOnChain(cwd, packagedSha, `refs/tags/${tag} (${packagedSha})`, frozen);
  return packagedSha;
}

export interface RetagMajorOptions {
  cwd: string;
  tag: string;
  sourceSha: string;
}

/** The version tag is re-verified against origin from scratch, never trusted from the local ref, and newestInLine
 * refuses a step backward: a rerun of an old release's job must not regress major-pinned consumers.
 *   the major moves after this run observed it                  -> the lease fails; re-read and retry
 *   a newer release lands between newestInLine and that read   -> not caught: the observed value is the newer one and the lease passes */
export function retagMajor(options: RetagMajorOptions): { major: string; packagedSha: string } {
  const { cwd, tag, sourceSha } = options;
  const ref = `refs/tags/${tag}`;
  git(cwd, "fetch", "--quiet", ...TAG_FETCH, "origin", `+${ref}:${ref}`);
  // The full verification, not a weaker probe: the major must never bless a commit a fresh package run would refuse.
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

/** Reads origin's refs afresh into refs/verify/: nothing this run holds locally is trusted. */
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
    ...TAG_FETCH,
    "origin",
    `+refs/tags/${tag}:refs/verify/${tag}`,
    `+refs/tags/${major}:refs/verify/${major}`,
  );
  const packagedSha = git(cwd, "rev-parse", `refs/verify/${tag}^{}`);
  const source = sourceTrailer(cwd, packagedSha);
  if (source !== sourceSha) {
    throw new Error(
      `origin's refs/tags/${tag} points at ${packagedSha}, which records ${source === "" ? "no source" : `${source} as its source`}, not this release's merge commit ${sourceSha}.`,
    );
  }
  // The verify job's checkout is main's head at depth 1; the merge commit's tree comes from origin by sha.
  git(cwd, "fetch", "--quiet", "--depth=1", "origin", sourceSha);
  const frozen =
    "the release-tags ruleset freezes version tags, so no rerun can replace it - inspect it by hand.";
  assertPackages(cwd, packagedSha, sourceSha, `origin's refs/tags/${tag} (${packagedSha})`, frozen);
  assertOnChain(cwd, packagedSha, `origin's refs/tags/${tag} (${packagedSha})`, frozen);
  const majorSha = git(cwd, "rev-parse", `refs/verify/${major}^{}`);
  if (majorSha !== packagedSha) {
    throw new Error(
      `origin's refs/tags/${major} points at ${majorSha}, not this release's packaged commit ${packagedSha}; if a newer release moved it during this run, this is stale-run noise - otherwise inspect both tags by hand.`,
    );
  }
  return { major, packagedSha };
}

/** checks.yml's head_ref conditions spell this by hand; test/docs/checks-workflow.test.ts pins them to it. */
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
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const branchRef = `refs/heads/${RELEASE_PR_BRANCH}`;
    if (git(cwd, "ls-remote", "origin", branchRef) === "") {
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
    // A newer push's run may already have refreshed and anchored the branch before the fetch above: this run's commit
    // then descends from that anchor, pushes cleanly, and regresses the boundary to the older head.
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

/** On main, last-release-sha must be the newest release merge or its parent; anything else means an anchor was lost
 * or a release merge slipped past the pipeline, and every release PR refresh would compute from a stale boundary.
 * A boundary NEWER than every recognized merge is a missed merge or a hand edit; either way it is never rolled back. */
export function boundaryCheck(cwd: string): { boundary: string } {
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      "boundary-check needs the full history (fetch-depth: 0) and this checkout is shallow: a release merge or the recorded boundary can sit beyond its depth, and no verdict on a truncated history holds.",
    );
  }
  const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8")) as {
    "last-release-sha"?: unknown;
  };
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

/** Run on the release PR's own checkout. The managed release-freshness gate proves the PR contains main's tip, not
 * that the anchor commit survived a release-please force-push, so requiring last-release-sha to equal origin's
 * CURRENT main tip makes an unanchored release PR unmergeable instead of parking the pipeline after its merge. */
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
  changed: boolean;
  /** The chain commit packaging this source, or the newer tip build was left at. */
  buildSha: string;
  /** Where refs/tags/latest points when this run ends: the chain commit packaging the newest source. */
  latestSha: string;
  reason: string;
}

/**
 * build only ever advances: the next chain commit is parented on the tip and pushed without force. latest follows
 * the newest source publishLatest can see rather than the tip alone, because a release-hook backfill can append an
 * older source behind newer ones.
 *
 *   the chain already packages sourceSha  -> nothing appended (its tree must match this build); latest reconciled
 *   the tip is already past sourceSha     -> left alone: a rerun of an older commit's run
 *   the tip's source is off main          -> stop; a hand push is never built on
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
      const found = findPackaged(cwd, sourceSha);
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
    console.error(`build push attempt ${attempt}/${attempts} overtaken: ${appended.overtaken}`);
  }
  throw new Error(
    `could not advance ${BUILD_REF} after ${attempts} attempts; something keeps moving it concurrently - rerun this job once it settles.`,
  );
}

/**
 * latest names the newest source among build's tip, this run's own chain commit, and where latest already points (a
 * stale rerun must not lease it back). The tip is older than the own commit only when the hook backfilled a release
 * behind commits post-green had appended.
 *   observe latest -> read the tip -> choose the target -> push with a lease on the observed value
 * Observing BEFORE the tip read is what makes the lease sound: build only advances and latest only names values build
 * has held, so the tip read is that value or newer, and a stale lease means another run moved latest.
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
      const newer = newerChainCommit(cwd, observed, targetSource, build.mainHead);
      if (newer !== null) {
        return {
          sha: newer.commit,
          reason: `${LATEST_REF} stays at ${newer.commit} (built from ${newer.source}), newer than ${target} (built from ${targetSource}); the next green push appends past it`,
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

/** A hand push with a newer Source trailer but a tampered tree, or off the chain, yields null and the target takes
 * over. The raw observed id stays the lease's expected value: an annotated tag's id is not its commit's. */
function newerChainCommit(
  cwd: string,
  observed: string,
  targetSource: string,
  mainHead: string,
): { commit: string; source: string } | null {
  git(cwd, "fetch", "--quiet", ...TAG_FETCH, "origin", LATEST_REF);
  // The tag can move between the ls-remote and this fetch; then the lease on the observed value settles it.
  if (git(cwd, "rev-parse", "FETCH_HEAD") !== observed) {
    return null;
  }
  const commit = git(cwd, "rev-parse", `${observed}^{commit}`);
  const source = sourceTrailer(cwd, commit);
  if (
    source === "" ||
    source === targetSource ||
    !isAncestor(cwd, source, mainHead) ||
    !isAncestor(cwd, targetSource, source)
  ) {
    return null;
  }
  if (!packages(cwd, commit, source)) {
    return null;
  }
  return isAncestor(cwd, commit, BUILD_REMOTE) ? { commit, source } : null;
}

/** The ruleset-protected chain is the trust boundary: a detached commit with the right tree, bytes, and Source
 * trailer must not be blessed as a release or become what latest names. */
function assertOnChain(cwd: string, packaged: string, ref: string, remedy: string): void {
  const build = readBuildTip(cwd);
  if (build.tip === null) {
    throw new Error(`${ref} exists but ${BUILD_REF} does not exist on origin; ${remedy}`);
  }
  if (!isAncestor(cwd, packaged, BUILD_REMOTE)) {
    throw new Error(
      `${ref} is not on ${BUILD_REF} (not an ancestor of its tip ${build.tip}); ${remedy}`,
    );
  }
}

function packages(cwd: string, packaged: string, source: string): boolean {
  try {
    assertPackages(cwd, packaged, source, packaged, "");
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
