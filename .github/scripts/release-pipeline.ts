/**
 * The release pipeline's git topology. main stays source-only, no version tag ever lands on it, and every ref a
 * consumer names points at a packaged commit on the `build` branch (the tags cut before that branch existed point
 * at main commits from when main still committed the bundle).
 *
 *   packaged commit    = source tree - .github/workflows - package.json's preparation scripts + lib/index.js + lib/pkg/, `Source: <sha>` trailer
 *   refs/heads/build   root (no parent) -> chain commit -> chain commit ...   only ever advances
 *   refs/tags/latest   -> the chain commit whose source is the newest on main
 *   refs/tags/vX.Y.Z   -> the chain commit whose source is the release's merge commit; never moved
 *   refs/tags/vX       -> the same commit, force-moved on each release; retagMajor refuses a step backward
 *
 * release-please cuts the DRAFT release without a tag (`draft` on, `force-tag-creation` off); one subcommand runs
 * per workflow step:
 *
 *   advance-build                  post-green.yml          GITHUB_SHA, RUN_URL (optional)
 *   prerelease-version             post-green.yml          GITHUB_SHA, GITHUB_RUN_NUMBER
 *   npm-verdict next               post-green.yml          GITHUB_SHA, GITHUB_RUN_NUMBER, NPM_REGISTRY_URL (optional)
 *   npm-verdict stable             update-release.yml      TAG, GITHUB_SHA, NPM_REGISTRY_URL (optional)
 *   package, retag-major           update-release.yml      TAG, GITHUB_SHA, RUN_URL (optional, package only)
 *   verify                         update-release.yml      TAG, GITHUB_SHA
 *   anchor                         update-release-pr.yml   GITHUB_SHA
 *   boundary-check, anchor-check   checks.yml              (the checkout alone)
 *
 * Node builtins only: bun runs this before `bun install`. Tests: test/scripts/release-pipeline*.test.ts over release-pipeline-fixture.ts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILE = ".release-please-manifest.json";
const CONFIG_FILE = "release-please-config.json";
/** What a chain commit carries beyond its source: the action bundle and the library build (a directory entry
 * stages every file under it). */
const PACKAGED_PATHS = ["lib/index.js", "lib/pkg/"] as const;
/** What every chain commit ever minted carries: the bundle `uses:` consumers run. */
const ACTION_BUNDLE = "lib/index.js";
/** What a ref minted or confirmed HERE must carry as non-empty regular files; the chain commits minted before the
 * library rode along carry the bundle alone and stay valid parents. */
const REQUIRED_BUILT_FILES = [ACTION_BUNDLE, "lib/pkg/index.js"] as const;
/** The packaged paths as the messages name them. */
const PACKAGED = "lib/index.js and lib/pkg/";
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

/** The one spelling of a commit the pipeline writes and compares: chain lookups match the Source trailer as a string
 * against rev-list's output, so an abbreviated, uppercase, or symbolic name git would resolve is still not a match. */
const FULL_SHA = /^[0-9a-f]{40}$/;

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

/** The identity the pipeline's own commits carry, passed per invocation: written into a checkout's config it would
 * outlive the run and stamp every later commit made from that repository, or any worktree sharing it. */
const BOT_IDENTITY = {
  GIT_AUTHOR_NAME: "settings-as-code-release",
  GIT_AUTHOR_EMAIL: "settings-as-code-release@users.noreply.github.com",
  GIT_COMMITTER_NAME: "settings-as-code-release",
  GIT_COMMITTER_EMAIL: "settings-as-code-release@users.noreply.github.com",
};

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

/** A consumable ref must carry each of `files` as a non-empty REGULAR file: a symlink or a gitlink at that path has
 * a size too, and no build. An existing chain commit is held to the action bundle alone (pre-library commits stay
 * valid parents); what this run mints or confirms, to the whole required set. */
function assertCarries(cwd: string, treeish: string, files: readonly string[]): void {
  for (const file of files) {
    // ls-tree answers a missing path with empty output and exit 0; a failing call (a missing object, a transport
    // error) must propagate, never read as "no bundle".
    const entry = git(cwd, "ls-tree", "-l", treeish, "--", file);
    const [mode = "", , , size] = entry.split(/\s+/);
    const regularFile = mode === "100644" || mode === "100755";
    if (!regularFile || Number(size) === 0) {
      const found = entry === "" ? "no entry" : `entry ${entry.split("\t")[0]}`;
      throw new Error(
        `${treeish} does not carry a non-empty regular-file ${file} (${found}); refusing to point a consumable ref at an unpackaged commit.`,
      );
    }
  }
}

function isPackagedPath(path: string): boolean {
  return PACKAGED_PATHS.some((packaged) =>
    packaged.endsWith("/") ? path.startsWith(packaged) : path === packaged,
  );
}

/** Every blob under the packaged paths in a tree, in git's own order. */
function packagedEntries(
  cwd: string,
  treeish: string,
): { mode: string; blob: string; path: string }[] {
  return git(cwd, "ls-tree", "-r", treeish, "--", ...PACKAGED_PATHS)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [meta = "", path = ""] = line.split("\t");
      const [mode = "", , blob = ""] = meta.split(/\s+/);
      return { mode, blob, path };
    });
}

/** The regular files the build left under the packaged paths in the checkout, as tree paths, sorted. */
function builtPaths(cwd: string): string[] {
  const paths: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(cwd, relative), { withFileTypes: true })) {
      const path = `${relative}${entry.name}`;
      if (entry.isDirectory()) {
        walk(`${path}/`);
      } else if (entry.isFile()) {
        paths.push(path);
      }
    }
  };
  for (const packaged of PACKAGED_PATHS) {
    if (!existsSync(join(cwd, packaged))) {
      continue;
    }
    if (packaged.endsWith("/")) {
      walk(packaged);
    } else {
      paths.push(packaged);
    }
  }
  return paths.sort();
}

/** Assembled in a private index read from sourceSha's tree, so nothing beyond that tree but the build outputs can
 * enter and the checkout's own index stays untouched. `manifest: "source"` keeps package.json as the source has it,
 * the shape of the chain commits minted before the prepare strip, which an existing tip is also held against. */
function treePlusBundle(
  cwd: string,
  sourceSha: string,
  addBuild: (env: Record<string, string>) => void,
  manifest: "stripped" | "source" = "stripped",
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
    if (manifest === "stripped") {
      const blob = strippedManifestBlob(cwd, sourceSha);
      if (blob !== null) {
        gitWithEnv(cwd, env, "update-index", "--add", "--cacheinfo", `100644,${blob},${MANIFEST}`);
      }
    }
    addBuild(env);
    return gitWithEnv(cwd, env, "write-tree");
  } finally {
    rmSync(indexFile, { force: true });
  }
}

const MANIFEST = "package.json";

/** The scripts npm's git fetcher (pacote) takes as a signal to run `npm install --include=dev` and the prepare
 * lifecycle in a `github:` dependency's checkout; the packaged commit ships the build already. */
export const PREPARATION_SCRIPTS = [
  "prepare",
  "prepack",
  "build",
  "preinstall",
  "install",
  "postinstall",
];

/** sourceSha's package.json without its preparation scripts, written to the object store; null when it has none. */
function strippedManifestBlob(cwd: string, sourceSha: string): string | null {
  const text = tryGit(cwd, "show", `${sourceSha}:${MANIFEST}`);
  if (text === null) {
    return null;
  }
  const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
  const scripts = pkg.scripts;
  const present = PREPARATION_SCRIPTS.filter((name) => scripts !== undefined && name in scripts);
  if (scripts === undefined || present.length === 0) {
    return null;
  }
  for (const name of present) {
    delete scripts[name];
  }
  return execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd,
    input: `${JSON.stringify(pkg, null, 2)}\n`,
    encoding: "utf8",
  }).trim();
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
  assertCarries(cwd, packaged, [ACTION_BUNDLE]);
  const entries = packagedEntries(cwd, packaged);
  const stage = (env: Record<string, string>): void => {
    for (const { mode, blob, path } of entries) {
      gitWithEnv(cwd, env, "update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`);
    }
  };
  const expected = treePlusBundle(cwd, source, stage);
  const actual = git(cwd, "rev-parse", `${packaged}^{tree}`);
  // COMPAT(v3): bundle-only chain commits stay valid parents; delete this arm, the assertCarries above, REQUIRED_BUILT_FILES' parent clause, and the legacy-chain test.
  // A commit that carries lib/pkg/ was minted after the strip and is held to it.
  const legacy =
    !entries.some(({ path }) => path.startsWith("lib/pkg/")) &&
    actual === treePlusBundle(cwd, source, stage, "source");
  if (actual !== expected && !legacy) {
    // An unchanged workflow file never shows in the diff against the source, so every workflow path still in the tree
    // is listed as kept; package.json is listed unless it is exactly the source's minus its preparation scripts.
    const stripped = strippedManifestBlob(cwd, source);
    const manifestBlob = tryGit(cwd, "rev-parse", `${packaged}:${MANIFEST}`);
    // Kept preparation scripts leave package.json identical to the source's, so the diff cannot list it either.
    const keptPrepare =
      stripped !== null && manifestBlob === tryGit(cwd, "rev-parse", `${source}:${MANIFEST}`);
    const changed = git(cwd, "diff", "--no-renames", "--name-only", source, packaged)
      .split("\n")
      .filter(
        (path) =>
          path !== "" &&
          !isPackagedPath(path) &&
          !path.startsWith(`${WORKFLOWS_DIR}/`) &&
          !(path === MANIFEST && stripped !== null && manifestBlob === stripped),
      )
      .concat(workflowPaths(cwd, packaged).map((path) => `${path} (kept)`))
      .concat(keptPrepare ? [`${MANIFEST} (preparation scripts kept)`] : []);
    const listed =
      changed.length === 0
        ? "none (an entry a path diff cannot list, such as an empty subtree)"
        : changed.join(", ");
    throw new Error(
      `${ref} is not ${source} plus ${PACKAGED}, minus ${MANIFEST}'s preparation scripts, and the removal of ` +
        `${WORKFLOWS_DIR}/ alone: its tree is ${actual}, the rebuilt one is ${expected} ` +
        `(paths beyond those changed relative to ${source}: ${listed}); ${remedy}`,
    );
  }
}

/** The checkout must BE sourceSha with a clean worktree: that is what makes the build outputs a build of that source
 * rather than of a by-hand edit. They are gitignored, so they never show as pending. */
function packagedTree(cwd: string, sourceSha: string): string {
  const head = git(cwd, "rev-parse", "HEAD");
  if (head !== sourceSha) {
    throw new Error(`the checkout is at ${head}, not the source commit ${sourceSha} to package.`);
  }
  for (const file of REQUIRED_BUILT_FILES) {
    if (!existsSync(join(cwd, file))) {
      throw new Error(`${file} is not built; run the build before packaging.`);
    }
  }
  const dirty = git(cwd, "status", "--porcelain").split("\n").filter(Boolean);
  if (dirty.length > 0) {
    throw new Error(
      `the worktree has pending changes beyond ${PACKAGED} (${dirty.join("; ")}); the build must be a build of ${sourceSha} alone - commit, stash, or clean them first.`,
    );
  }
  // -f: main gitignores the build outputs
  const tree = treePlusBundle(cwd, sourceSha, (env) =>
    gitWithEnv(cwd, env, "add", "-f", "--", ...PACKAGED_PATHS),
  );
  assertCarries(cwd, tree, REQUIRED_BUILT_FILES);
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
  const trailers = [`Source: ${sourceSha}`];
  if (runUrl !== undefined) {
    trailers.push(`Workflow-run: ${runUrl}`);
  }
  const subject = `build: main at ${git(cwd, "rev-parse", "--short", sourceSha)}`;
  const parents = parent === null ? [] : ["-p", parent];
  return gitWithEnv(
    cwd,
    BOT_IDENTITY,
    "commit-tree",
    ...parents,
    "-m",
    subject,
    "-m",
    trailers.join("\n"),
    tree,
  );
}

interface BuildTip {
  tip: string | null;
  /** Read AFTER the tip, so a commit landing between the two reads postdates the tip rather than the refresh. */
  mainHead: string;
}

/** A chain commit and the main commit its Source trailer names, as a full sha. */
interface ChainCommit {
  commit: string;
  source: string;
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

/** Each source the chain packages, mapped to the newest chain commit packaging it. The pipeline appends a source
 * only after finding no commit for it, so a second commit for one source can only be a hand push. */
function chainPackaging(cwd: string): Map<string, string> {
  const packaging = new Map<string, string>();
  const log = git(cwd, "log", "--format=%H%x09%(trailers:key=Source,valueonly)", BUILD_REMOTE);
  for (const line of log.split("\n")) {
    const [commit = "", source = ""] = line.split("\t");
    if (commit !== "" && source !== "" && !packaging.has(source)) {
      packaging.set(source, commit);
    }
  }
  return packaging;
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
  if (!FULL_SHA.test(tipSource)) {
    throw new Error(
      `${BUILD_REF} is at ${tip}, whose Source trailer ${JSON.stringify(tipSource)} is not a full commit sha, so this pipeline did not mint it; ${BY_HAND}`,
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
        `so the two differ under ${PACKAGED} (bytes, file modes, or the files under lib/pkg/): either the commit ` +
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
  const manifest = manifestVersionAt(cwd, "HEAD");
  if (tag !== `v${manifest}`) {
    throw new Error(
      `tag ${tag} does not match the manifest version ${JSON.stringify(manifest)} at ${sourceSha}; refusing to package a version this source did not release.`,
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
    const latest = publishLatest(cwd, 3);
    console.error(latest.reason);
    return { created: false, packagedSha: verified, latestSha: latest.sha };
  }
  const attempts = 3;
  let packagedSha: string | null = null;
  for (let attempt = 1; attempt <= attempts && packagedSha === null; attempt++) {
    const build = readBuildTip(cwd);
    const found = build.tip === null ? undefined : chainPackaging(cwd).get(sourceSha);
    if (found !== undefined) {
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
  const latest = publishLatest(cwd, attempts);
  console.error(latest.reason);
  return { created: true, packagedSha, latestSha: latest.sha };
}

/** An existing tag is trusted only as THIS source's package. A planted commit that keeps the expected build outputs
 * but edits action.yml fails the tree check; one whose files or bytes differ from the fresh build fails the byte check. */
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
  const tagged = packagedEntries(cwd, packagedSha)
    .map((entry) => entry.path)
    .sort();
  const built = builtPaths(cwd);
  if (tagged.join("\n") !== built.join("\n")) {
    throw new Error(
      `refs/tags/${tag} carries [${tagged.join(", ")}] under ${PACKAGED}, while this build of ${sourceSha} produced [${built.join(", ")}]; ${frozen}`,
    );
  }
  for (const path of built) {
    const taggedBytes = gitBytes(cwd, "show", `${packagedSha}:${path}`);
    if (!taggedBytes.equals(readFileSync(join(cwd, path)))) {
      throw new Error(
        `refs/tags/${tag} carries a ${path} that is not a build of ${sourceSha}'s source; ${frozen}`,
      );
    }
  }
  assertOnChain(cwd, packagedSha, `refs/tags/${tag} (${packagedSha})`, frozen);
  return packagedSha;
}

export interface RetagMajorOptions {
  cwd: string;
  tag: string;
  sourceSha: string;
}

/** The version tag is re-verified against origin from scratch, never trusted from the local ref, and the major never
 * steps backward: a rerun of an old release's job must not regress major-pinned consumers. The line's tags and the
 * major's value come from ONE advertisement, so the release the compare judged is the release the lease holds
 * against: a newer release landing after it either moved the major (the lease fails; re-read and retry) or has not
 * yet (its own move follows, and a lease of its own settles the order). */
export function retagMajor(options: RetagMajorOptions): { major: string; packagedSha: string } {
  const { cwd, tag, sourceSha } = options;
  const ref = `refs/tags/${tag}`;
  git(cwd, "fetch", "--quiet", ...TAG_FETCH, "origin", `+${ref}:${ref}`);
  // The full verification, not a weaker probe: the major must never bless a commit a fresh package run would refuse.
  const packagedSha = verifyPackagedTag(cwd, tag, sourceSha);
  const major = releaseMajor(tag);
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const line = observeMajorLine(cwd, major);
    if (line.newest !== null && line.newest !== tag) {
      throw new Error(
        `${line.newest} already exists in the ${major} line, so ${major} must stay on it; refusing to move ${major} back to ${tag} (a rerun of an old release's job must not regress major-pinned consumers).`,
      );
    }
    git(cwd, "tag", "-f", major, packagedSha);
    const push = pushUnlessOvertaken(
      cwd,
      `--force-with-lease=refs/tags/${major}:${line.observed}`,
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

/** The major's value and the newest release tag in its line, from one advertisement. */
function observeMajorLine(cwd: string, major: string): { observed: string; newest: string | null } {
  const listed = git(cwd, "ls-remote", "origin", `refs/tags/${major}`, `refs/tags/${major}.*`);
  let observed = "";
  let newest: number[] | null = null;
  for (const line of listed.split("\n")) {
    const [sha = "", name] = line.split("\t");
    if (name === `refs/tags/${major}`) {
      observed = sha;
      continue;
    }
    const match = name?.match(/^refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
      continue;
    }
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (newest === null || isNewer(parts, newest)) {
      newest = parts;
    }
  }
  return { observed, newest: newest === null ? null : `v${newest.join(".")}` };
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
  assertCarries(cwd, packagedSha, REQUIRED_BUILT_FILES);
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
 * the chain's newest main source rather than the tip, because a release-hook backfill can append an older source
 * behind newer ones.
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
  const latest = publishLatest(cwd, attempts);
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
      const found = chainPackaging(cwd).get(sourceSha);
      if (found !== undefined) {
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
 * latest names the chain commit whose source is the newest on main, read off the whole chain: the tip alone is wrong
 * after the release hook backfills an older source behind newer ones, and the run's own commit alone when the run
 * that appended the newer source lost its latest push before that backfill.
 *   observe latest -> read the chain -> pick the target -> push with a lease on the observed value
 * Observing BEFORE the chain read is what makes the lease sound: build only advances and latest only names values
 * build has held, so the chain read is that value or newer, and a stale lease means another run moved latest.
 */
function publishLatest(cwd: string, attempts: number): { sha: string; reason: string } {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const observed = observeRemote(cwd, LATEST_REF);
    const build = readBuildTip(cwd);
    if (build.tip === null) {
      throw new Error(
        `${BUILD_REF} vanished after this run appended to it; inspect origin by hand.`,
      );
    }
    const tipSource = validateTip(cwd, build.tip, build.mainHead);
    const target = chainCommitOfNewestSource(cwd, build.mainHead, {
      commit: build.tip,
      source: tipSource,
    });
    if (target.commit !== build.tip) {
      assertPackages(
        cwd,
        target.commit,
        target.source,
        `${BUILD_REF} holds ${target.commit}, which names ${target.source} as its source but`,
        BY_HAND,
      );
    }
    if (observed.peeled === target.commit) {
      return { sha: target.commit, reason: `${LATEST_REF} already at ${target.commit}` };
    }
    const push = pushUnlessOvertaken(
      cwd,
      `--force-with-lease=${LATEST_REF}:${observed.id}`,
      "origin",
      `${target.commit}:${LATEST_REF}`,
    );
    if (push.landed) {
      return { sha: target.commit, reason: `${LATEST_REF}: moved to ${target.commit}` };
    }
    console.error(`latest lease push attempt ${attempt}/${attempts} overtaken: ${push.stderr}`);
  }
  throw new Error(
    `could not move ${LATEST_REF} after ${attempts} compare-and-swap attempts; something keeps moving it concurrently - rerun this job once it settles.`,
  );
}

/** A ref as origin advertises it: the id a lease holds against, and the commit it peels to (an annotated tag's id
 * is not its commit's). Both empty when the ref does not exist. The peeled line is advertised only when its own
 * pattern asks for it. */
function observeRemote(cwd: string, ref: string): { id: string; peeled: string } {
  let id = "";
  let peeled = "";
  for (const line of git(cwd, "ls-remote", "origin", ref, `${ref}^{}`).split("\n")) {
    const [sha = "", name] = line.split("\t");
    if (name === ref) {
      id = sha;
    } else if (name === `${ref}^{}`) {
      peeled = sha;
    }
  }
  return { id, peeled: peeled === "" ? id : peeled };
}

/** The chain commit packaging the newest main source, in MAIN's order rather than the chain's: a release-hook
 * backfill appends an older source behind newer ones. The validated tip is the floor: its source is on main under
 * its full sha, so only the main commits newer than it are searched and the tip stands when none is packaged. */
function chainCommitOfNewestSource(cwd: string, mainHead: string, tip: ChainCommit): ChainCommit {
  const packaging = chainPackaging(cwd);
  const newer = git(cwd, "rev-list", "--topo-order", `${tip.source}..${mainHead}`);
  for (const source of newer.split("\n")) {
    const commit = packaging.get(source);
    if (commit !== undefined) {
      return { commit, source };
    }
  }
  return tip;
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

/** The manifest's version at a commit: what release-please last released, or is about to. */
function manifestVersionAt(cwd: string, treeish: string): string {
  const manifest = JSON.parse(git(cwd, "show", `${treeish}:${MANIFEST_FILE}`)) as Record<
    string,
    unknown
  >;
  return String(manifest["."]);
}

/**
 * The npm version a green main commit's library build publishes under the
 * `next` dist-tag: the manifest version's next patch, then a pre-release
 * suffix of the workflow run number and the source's short sha. That sorts
 * above the last release, below the next one whatever its bump, forward
 * across runs (run numbers only grow), and once per run. The sha carries a
 * `g` prefix, as git describe writes it: npm reads an all-digit identifier
 * as a number and drops its leading zero, so a bare sha7 such as 0123456
 * would be rewritten to 123456 and name no commit.
 */
export function prereleaseVersion(
  manifestVersion: string,
  runNumber: string,
  sourceSha: string,
): string {
  const version = manifestVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!version) {
    throw new Error(
      `the manifest version ${JSON.stringify(manifestVersion)} is not X.Y.Z; refusing to derive a pre-release version from it.`,
    );
  }
  if (!/^(0|[1-9]\d*)$/.test(runNumber)) {
    throw new Error(
      `the run number ${JSON.stringify(runNumber)} is not a decimal integer; refusing to mint a pre-release version from it.`,
    );
  }
  if (!FULL_SHA.test(sourceSha)) {
    throw new Error(
      `the source ${JSON.stringify(sourceSha)} is not a full commit sha; refusing to mint a pre-release version from it.`,
    );
  }
  const [, major, minor, patch] = version;
  return `${major}.${minor}.${Number(patch) + 1}-main.${runNumber}.g${sourceSha.slice(0, 7)}`;
}

export interface PrereleaseVersionOptions {
  cwd: string;
  /** The green main commit this run judged; the checkout must be at it. */
  sourceSha: string;
  /** The workflow run number, the pre-release's forward-moving component. */
  runNumber: string;
}

/** prereleaseVersion for the checkout: the manifest is read at sourceSha, which HEAD must be. */
export function prereleaseVersionOf(options: PrereleaseVersionOptions): string {
  const { cwd, sourceSha, runNumber } = options;
  const head = git(cwd, "rev-parse", "HEAD");
  if (head !== sourceSha) {
    throw new Error(
      `the checkout is at ${head}, not the source commit ${sourceSha} whose build is published.`,
    );
  }
  return prereleaseVersion(manifestVersionAt(cwd, sourceSha), runNumber, sourceSha);
}

/** A version this pipeline mints, parsed for ordering: a release, or a pre-release of one. */
interface MintedVersion {
  release: [number, number, number];
  pre: { run: number; sha: string } | null;
}

/** The two version shapes this pipeline mints; anything else (a hand-published
 * 2.0.1-beta.1 the registry now holds) stops the run rather than being guessed at. */
function parseMinted(version: string): MintedVersion {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-main\.(0|[1-9]\d*)\.g([0-9a-f]{7}))?$/);
  if (!match) {
    throw new Error(
      `${JSON.stringify(version)} is not a version this pipeline mints (X.Y.Z or X.Y.Z-main.<run>.g<sha7>); refusing to order it.`,
    );
  }
  const [, major = "", minor = "", patch = "", run, sha = ""] = match;
  return {
    release: [Number(major), Number(minor), Number(patch)],
    pre: run === undefined ? null : { run: Number(run), sha },
  };
}

/**
 * How npm orders two minted versions: by release first; a pre-release sorts
 * below its own release; pre-releases of one release sort by run number, then
 * by the sha as npm compares identifiers (lexically).
 */
export function versionOrder(a: string, b: string): "newer" | "same" | "older" {
  const left = parseMinted(a);
  const right = parseMinted(b);
  for (let i = 0; i < 3; i++) {
    const l = left.release[i] ?? 0;
    const r = right.release[i] ?? 0;
    if (l !== r) {
      return l > r ? "newer" : "older";
    }
  }
  if (left.pre === null || right.pre === null) {
    if (left.pre === right.pre) {
      return "same";
    }
    return left.pre === null ? "newer" : "older";
  }
  if (left.pre.run !== right.pre.run) {
    return left.pre.run > right.pre.run ? "newer" : "older";
  }
  if (left.pre.sha === right.pre.sha) {
    return "same";
  }
  return left.pre.sha > right.pre.sha ? "newer" : "older";
}

/** What the registry holds for the package: every published version, and where each dist-tag points. */
export interface Packument {
  versions: Record<string, unknown>;
  "dist-tags": Record<string, string>;
}

export type PublishVerdict =
  | { publish: true; version: string }
  | { publish: false; version: string; reason: string };

/**
 * Both dist-tags are consulted, not only `next`: `npm publish --tag next`
 * moves next to whatever it publishes, so a stale run's version must be newer
 * than what next AND latest name, or next would step back behind a release.
 * Null is a package the registry has never seen: the bootstrap publishes.
 */
export function nextPublishVerdict(version: string, packument: Packument | null): PublishVerdict {
  if (packument === null) {
    return { publish: true, version };
  }
  if (version in packument.versions) {
    return { publish: false, version, reason: `${version} is already on the registry` };
  }
  for (const tag of ["next", "latest"]) {
    const current = packument["dist-tags"][tag];
    if (current !== undefined && versionOrder(version, current) !== "newer") {
      return {
        publish: false,
        version,
        reason: `the registry's ${tag} is ${current}, not older than ${version}, so this stale run publishes nothing (npm publish --tag next would move next back)`,
      };
    }
  }
  return { publish: true, version };
}

/**
 * Only `latest` is consulted: a plain `npm publish` moves latest and leaves
 * next alone, and a release is meant to sort below the pre-releases that
 * followed its merge (the merge commit's own run publishes the next patch's
 * pre-release before this job runs).
 */
export function stablePublishVerdict(version: string, packument: Packument | null): PublishVerdict {
  if (packument === null) {
    return { publish: true, version };
  }
  if (version in packument.versions) {
    return { publish: false, version, reason: `${version} is already on the registry` };
  }
  const latest = packument["dist-tags"].latest;
  // The hand bootstrap leaves a pre-release on latest: a packument always carries that key (npm/registry
  // REGISTRY-API.md, "dist-tags: an object with at least one key, latest"), so a first publish gets it whatever
  // --tag asked for. A release must take latest over from it, so only a newer RELEASE holds one back.
  if (
    latest !== undefined &&
    parseMinted(latest).pre === null &&
    versionOrder(version, latest) === "older"
  ) {
    return {
      publish: false,
      version,
      reason: `the registry's latest is ${latest}, newer than ${version}, so this rerun of an older release publishes nothing (npm publish would move latest back)`,
    };
  }
  return { publish: true, version };
}

/** The registry's record of `name`, or null while it has never been published; any other answer than 200 or 404 throws. */
async function fetchPackument(registry: string, name: string): Promise<Packument | null> {
  const url = `${registry.replace(/\/$/, "")}/${name.replaceAll("/", "%2F")}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `the registry answered ${response.status} for ${name} (${url}); refusing to publish without knowing what it holds.`,
    );
  }
  const body: unknown = await response.json();
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!record(body) || !record(body.versions) || !record(body["dist-tags"])) {
    throw new Error(
      `the registry's record of ${name} (${url}) is not a packument (an object with versions and dist-tags records); refusing to publish without knowing what it holds.`,
    );
  }
  const tags = body["dist-tags"];
  for (const [tag, value] of Object.entries(tags)) {
    if (typeof value !== "string") {
      throw new Error(
        `the registry's record of ${name} names dist-tag ${tag} as ${JSON.stringify(value)}, not a version; refusing to publish without knowing what it holds.`,
      );
    }
  }
  return { versions: body.versions, "dist-tags": tags as Record<string, string> };
}

function packageFieldAt(cwd: string, treeish: string, field: "name" | "version"): string {
  const pkg = JSON.parse(git(cwd, "show", `${treeish}:package.json`)) as Record<string, unknown>;
  return String(pkg[field]);
}

/** The version npm publishes for a release: package.json's, which must be the
 * tag's (the hook held the manifest to the tag; package.json is a separate file
 * release-please rewrites, and it is the one npm reads). */
function releaseVersionAt(cwd: string, treeish: string, tag: string): string {
  const version = packageFieldAt(cwd, treeish, "version");
  if (`v${version}` !== tag) {
    throw new Error(
      `package.json at the release source is version ${version}, but the release tag is ${tag}; refusing to publish a version this source did not release.`,
    );
  }
  return version;
}

export type NpmVerdictOptions = {
  cwd: string;
  /** The commit whose build is published; the checkout must be at it. */
  sourceSha: string;
  /** The registry's base URL, where the package's record is read. */
  registry: string;
} & ({ channel: "next"; runNumber: string } | { channel: "stable"; tag: string });

/** The publish decision for the checkout, against what the registry holds.
 * The version is settled before the registry is asked, so a checkout that
 * cannot name one stops without a request. */
export async function npmVerdict(options: NpmVerdictOptions): Promise<PublishVerdict> {
  const { cwd, sourceSha, registry } = options;
  const head = git(cwd, "rev-parse", "HEAD");
  if (head !== sourceSha) {
    throw new Error(
      `the checkout is at ${head}, not the source commit ${sourceSha} whose build is published.`,
    );
  }
  const version =
    options.channel === "next"
      ? prereleaseVersion(manifestVersionAt(cwd, "HEAD"), options.runNumber, sourceSha)
      : releaseVersionAt(cwd, "HEAD", options.tag);
  const packument = await fetchPackument(registry, packageFieldAt(cwd, "HEAD", "name"));
  return options.channel === "next"
    ? nextPublishVerdict(version, packument)
    : stablePublishVerdict(version, packument);
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

async function main(): Promise<void> {
  const cwd = process.cwd();
  const [command, argument] = process.argv.slice(2);
  const env = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} is required for "${command}"`);
    }
    return value;
  };
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
        `origin's ${env("TAG")} and ${result.major} both point at packaged commit ${result.packagedSha}, whose tree carries ${PACKAGED}`,
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
    // The two subcommands whose result is their stdout: the workflow captures it.
    case "prerelease-version": {
      console.log(
        prereleaseVersionOf({
          cwd,
          sourceSha: env("GITHUB_SHA"),
          runNumber: env("GITHUB_RUN_NUMBER"),
        }),
      );
      break;
    }
    case "npm-verdict": {
      if (argument !== "next" && argument !== "stable") {
        throw new Error(
          `npm-verdict takes the channel, next or stable, not ${JSON.stringify(argument ?? null)}`,
        );
      }
      const verdict = await npmVerdict({
        cwd,
        sourceSha: env("GITHUB_SHA"),
        registry: process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY,
        ...(argument === "next"
          ? { channel: argument, runNumber: env("GITHUB_RUN_NUMBER") }
          : { channel: argument, tag: env("TAG") }),
      });
      console.log(verdict.publish ? `publish ${verdict.version}` : `skip ${verdict.reason}`);
      break;
    }
    default:
      throw new Error(
        `unknown command ${JSON.stringify(command ?? null)}; expected package | retag-major | verify | anchor | boundary-check | anchor-check | advance-build | prerelease-version | npm-verdict`,
      );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `release-pipeline ${process.argv[2] ?? ""}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
