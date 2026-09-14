/**
 * The release pipeline's git topology. main stays source-only, no version tag ever lands on it, and every ref a
 * consumer names points at a packaged commit: the child of one main commit, carrying that commit's build.
 *
 *   packaged commit                = parent: the main commit; tree: its tree + lib/index.js + lib/pkg/, package.json minus its preparation scripts
 *   refs/tags/build/<pos>.<sha7>   -> the packaged commit of the main commit at first-parent position <pos>; created once, never moved; the ten newest kept
 *   refs/tags/latest               -> the packaged commit of the newest main commit
 *   refs/tags/vX.Y.Z               -> the packaged commit of the release's merge commit; never moved
 *   refs/tags/vX                   -> the same commit, moved on each release in the line
 *
 * Every artifact is a function of its main commit alone, so runs for different commits never wait on each other
 * and a rerun mints the same name and verifies instead of appending. latest and vX move through movePointer alone:
 * forward along main, under a compare-and-set on the value origin advertised, never back. The `build` branch that
 * carried a chain of packaged commits before the tags is history: this script never reads it, and the branch
 * was deleted on 2026-09-13.
 *
 * release-please cuts the DRAFT release without a tag (`draft` on, `force-tag-creation` off); one subcommand runs
 * per workflow step:
 *
 *   package-commit                 post-green.yml          GITHUB_SHA, RUN_URL (optional)
 *   prerelease-version             post-green.yml          GITHUB_SHA
 *   npm-verdict next               post-green.yml          GITHUB_SHA, NPM_REGISTRY_URL (optional)
 *   npm-confirm next               post-green.yml          GITHUB_SHA, NPM_REGISTRY_URL (optional), NPM_CONFIRM_PAUSE_MS (optional)
 *   npm-verdict stable             update-release.yml      TAG, GITHUB_SHA, NPM_REGISTRY_URL (optional)
 *   package, retag-major           update-release.yml      TAG, GITHUB_SHA, RUN_URL (optional, package only)
 *   anchor                         update-release-pr.yml   GITHUB_SHA
 *   boundary-check, anchor-check   checks.yml              (the checkout alone)
 *
 * Node builtins only: bun runs this before `bun install`. Tests: test/scripts/release-pipeline*.test.ts over release-pipeline-fixture.ts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MANIFEST_FILE = ".release-please-manifest.json";
const CONFIG_FILE = "release-please-config.json";
const MANIFEST = "package.json";
/** What a packaged commit carries beyond its source (a directory entry stages every file under it). */
const PACKAGED_PATHS = ["lib/index.js", "lib/pkg/"] as const;
/** What every packaged commit must carry as non-empty regular files. */
const REQUIRED_BUILT_FILES = ["lib/index.js", "lib/pkg/index.js"] as const;
const PACKAGED = "lib/index.js and lib/pkg/";
const LATEST_REF = "refs/tags/latest";
const BUILD_TAG_PREFIX = "refs/tags/build/";
const BUILD_TAG = /^refs\/tags\/build\/([1-9]\d*)\.[0-9a-f]{7}$/;
/** How many build tags stay; releases and latest keep their own commits. */
export const KEPT_BUILD_TAGS = 10;
/** Never --depth: a depth-limited fetch marks the commit it lands on shallow and cuts the parent link every package
 * check reads. Blobs arrive on demand, or with the commit on a server without filter support. */
const TAG_FETCH = ["--filter=blob:none"];
/** A squash-merged release-please PR's subject on main. Anchored at both ends wherever release merges are recognized:
 * a prefix match would let "chore(main): release pipeline documentation" impersonate one and park the boundary check. */
const RELEASE_SUBJECT = /^chore\(main\): release (\d+\.\d+\.\d+)(?: \(#\d+\))?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const PUSH_ATTEMPTS = 3;

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

/** git's stdout, or null when it exited 1 (a "no" from --verify, --is-ancestor, and the like); any other failure
 * is thrown, so a repository git cannot read never passes for one without the object. */
function gitOrNo(cwd: string, ...args: string[]): string | null {
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

/** A push as git ran it. A refusal is never read from git's words: the caller re-reads origin, and a ref that
 * moved since it was observed is a lost compare-and-set to retry, an unmoved one a refusal to throw. */
function push(cwd: string, ...pushArgs: string[]): Error | null {
  try {
    execFileSync("git", ["push", ...pushArgs], { cwd, encoding: "utf8" });
    return null;
  } catch (error) {
    return gitFailure(["push", ...pushArgs], error);
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

/** Verdicts on a truncated history do not hold; the jobs check out with fetch-depth 0. */
function assertFullHistory(cwd: string, what: string, consequence: string): void {
  if (git(cwd, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(
      `${what} needs the full history (fetch-depth: 0) and this checkout is shallow: ${consequence}`,
    );
  }
}

/** merge-base fails outright on a sha this checkout lacks, so unknown ones are screened into a plain "no" first. */
function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return (
    [ancestor, descendant].every((sha) => resolveCommit(cwd, sha) !== null) &&
    gitOrNo(cwd, "merge-base", "--is-ancestor", ancestor, descendant) !== null
  );
}

/** The commit a name resolves to, or null for none (a sha the checkout lacks, or a short one naming several objects). */
function resolveCommit(cwd: string, name: string): string | null {
  return gitOrNo(cwd, "rev-parse", "--verify", "--quiet", `${name}^{commit}`);
}

/** The required build files as non-empty REGULAR files: a symlink or a gitlink at that path has a size too, and no build. */
function assertCarries(cwd: string, treeish: string, what: string, remedy: string): void {
  for (const file of REQUIRED_BUILT_FILES) {
    // ls-tree answers a missing path with empty output and exit 0; a failing call must propagate.
    const entry = git(cwd, "ls-tree", "-l", treeish, "--", file);
    const [mode = "", , , size] = entry.split(/\s+/);
    if ((mode !== "100644" && mode !== "100755") || Number(size) === 0) {
      throw new Error(
        `${what} does not carry a non-empty regular-file ${file} (${entry === "" ? "no entry" : `entry ${entry.split("\t")[0]}`}); refusing to point a consumable ref at an unpackaged commit; ${remedy}`,
      );
    }
  }
}

/** The scripts npm's git fetcher (pacote) takes as a signal to run `npm install --include=dev` and the prepare
 * lifecycle in a `github:` dependency's checkout; the packaged commit ships the build already. */
const PREPARATION_SCRIPTS = ["prepare", "prepack", "build", "preinstall", "install", "postinstall"];

/** sourceSha's tree plus `addBuild`'s entries, with package.json's preparation scripts removed, assembled in a
 * private index so nothing else can enter and the checkout's own index stays untouched. */
function packagedTreeOf(
  cwd: string,
  sourceSha: string,
  addBuild: (env: Record<string, string>) => void,
): string {
  const indexFile = join(git(cwd, "rev-parse", "--absolute-git-dir"), "release-pipeline.index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    gitWithEnv(cwd, env, "read-tree", sourceSha);
    const text = tryGit(cwd, "show", `${sourceSha}:${MANIFEST}`);
    const pkg = text === null ? null : (JSON.parse(text) as { scripts?: Record<string, unknown> });
    if (pkg?.scripts && PREPARATION_SCRIPTS.some((name) => name in (pkg.scripts ?? {}))) {
      for (const name of PREPARATION_SCRIPTS) {
        delete pkg.scripts[name];
      }
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd,
        input: `${JSON.stringify(pkg, null, 2)}\n`,
        encoding: "utf8",
      }).trim();
      gitWithEnv(cwd, env, "update-index", "--add", "--cacheinfo", `100644,${blob},${MANIFEST}`);
    }
    addBuild(env);
    return gitWithEnv(cwd, env, "write-tree");
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/**
 * `packaged` is a package of `sourceSha` as this pipeline mints them: its child (the parent edge is the one record
 * of the source), carrying the source's tree plus the build outputs and the stripped manifest, nothing else, every
 * required build file a regular file. With `built`, the tree this checkout's fresh build produced, the packaged tree
 * must be that tree byte for byte (a tree id names every byte and mode under it).
 */
function assertPackageOf(
  cwd: string,
  packaged: string,
  sourceSha: string,
  what: string,
  remedy: string,
  built?: string,
): void {
  const parents = git(cwd, "log", "-1", "--format=%P", packaged).split(" ").filter(Boolean);
  if (parents.length !== 1 || parents[0] !== sourceSha) {
    throw new Error(
      `${what} has ${parents.length === 0 ? "no parent" : `parent ${parents.join(", ")}`}, so it is no package of ${sourceSha} (a packaged commit is that commit's child); ${remedy}`,
    );
  }
  const actual = git(cwd, "rev-parse", `${packaged}^{tree}`);
  if (built !== undefined && actual === built) {
    return;
  }
  // Rebuilt from the source with the packaged commit's own build entries: tree identity, so an empty subtree a
  // path diff cannot list still differs.
  const entries = git(cwd, "ls-tree", "-r", packaged, "--", ...PACKAGED_PATHS)
    .split("\n")
    .filter(Boolean);
  const expected = packagedTreeOf(cwd, sourceSha, (env) => {
    for (const line of entries) {
      const [meta = "", path = ""] = line.split("\t");
      const [mode = "", , blob = ""] = meta.split(/\s+/);
      gitWithEnv(cwd, env, "update-index", "--add", "--cacheinfo", `${mode},${blob},${path}`);
    }
  });
  if (actual !== expected) {
    throw new Error(
      `${what} is not ${sourceSha} plus ${PACKAGED}, minus ${MANIFEST}'s preparation scripts, alone: its tree is ${actual}, the rebuilt one is ${expected} (git diff ${expected} ${packaged} lists what deviates); ${remedy}`,
    );
  }
  assertCarries(cwd, packaged, what, remedy);
  if (built !== undefined) {
    throw new Error(
      `${what} packages ${sourceSha}, but its tree ${actual} is not the tree ${built} this checkout's build packages, ` +
        `so the two differ under ${PACKAGED}: either the commit was not built from this source or the build is not ` +
        `reproducible. Diff the two trees by hand; ${remedy}`,
    );
  }
}

/** The checkout must BE sourceSha with a clean worktree: that is what makes the build outputs a build of that source
 * rather than of a by-hand edit. They are gitignored, so they never show as pending. */
function builtTree(cwd: string, sourceSha: string): string {
  const head = git(cwd, "rev-parse", "HEAD");
  if (head !== sourceSha) {
    throw new Error(`the checkout is at ${head}, not the source commit ${sourceSha} to package.`);
  }
  const dirty = git(cwd, "status", "--porcelain").split("\n").filter(Boolean);
  if (dirty.length > 0) {
    throw new Error(
      `the worktree has pending changes beyond ${PACKAGED} (${dirty.join("; ")}); the build must be a build of ${sourceSha} alone - commit, stash, or clean them first.`,
    );
  }
  // -f: main gitignores the build outputs; a path the build left out is reported by the carry check, not by git add.
  const built = PACKAGED_PATHS.filter((path) => existsSync(join(cwd, path)));
  const tree = packagedTreeOf(cwd, sourceSha, (env) => {
    if (built.length > 0) {
      gitWithEnv(cwd, env, "add", "-f", "--", ...built);
    }
  });
  assertCarries(cwd, tree, `the build of ${sourceSha}`, "run the build before packaging.");
  return tree;
}

/** A plain fetch does not deepen a shallow clone, so ancestry against this head holds only on a full checkout. */
function fetchMainHead(cwd: string): string {
  git(cwd, "fetch", "--quiet", "origin", "refs/heads/main");
  return git(cwd, "rev-parse", "FETCH_HEAD");
}

function assertOnMain(cwd: string, sourceSha: string, refusal: string): void {
  const mainHead = fetchMainHead(cwd);
  if (!isAncestor(cwd, sourceSha, mainHead)) {
    throw new Error(
      `${sourceSha} is not on origin's main (its head is ${mainHead}); refusing to ${refusal}.`,
    );
  }
}

/** A ref as origin advertises it: the id a lease holds against, and the commit it peels to (an annotated tag's id
 * is not its commit's). Both empty when the ref does not exist. */
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

/** Bring an observed ref's commit into this clone by the ref's name (origin serves no fetch by arbitrary sha). The
 * ref can move or vanish between the observation and the fetch; the caller re-observes and decides again then. A
 * fetch that fails with the ref standing where it was read is thrown. */
function fetchObserved(cwd: string, ref: string, observedId: string): boolean {
  try {
    git(cwd, "fetch", "--quiet", ...TAG_FETCH, "origin", `+${ref}:${ref}`);
  } catch (error) {
    if (observeRemote(cwd, ref).id === observedId) {
      throw error;
    }
    return false;
  }
  return git(cwd, "rev-parse", ref) === observedId;
}

/** A packaged commit and the main commit it packages (its parent). */
interface Packaged {
  commit: string;
  source: string;
}

interface EnsuredTag extends Packaged {
  created: boolean;
  ref: string;
}

/**
 * A tag that exists exactly once: an existing one is fetched and `verify`d, an absent one is created with a plain
 * push (no force, no lease) on the commit `mint` returns. git refuses the push once the tag exists, so the loser of
 * two runs verifies the winner's commit as a rerun does. A ref that vanishes or moves mid-read is read again, and so
 * is a refused create whose ref is absent on the re-read (a rival created and pruned it in between, or the push was
 * refused for good: the two look alike, so the refusal is thrown only once every attempt is spent).
 */
function ensureTag(
  cwd: string,
  ref: string,
  source: string,
  mint: () => string,
  verify: (peeled: string) => void,
): EnsuredTag {
  let refused: Error | null = null;
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    const observed = observeRemote(cwd, ref);
    if (observed.id !== "") {
      if (!fetchObserved(cwd, ref, observed.id)) {
        continue;
      }
      verify(observed.peeled);
      return { created: false, ref, commit: observed.peeled, source };
    }
    const commit = mint();
    refused = push(cwd, "origin", `${commit}:${ref}`);
    if (refused === null) {
      return { created: true, ref, commit, source };
    }
  }
  throw (
    refused ??
    new Error(
      `${ref} kept changing under this run through ${PUSH_ATTEMPTS} reads; something keeps creating and deleting it - rerun this job once it settles.`,
    )
  );
}

const BUILD_REMEDY =
  "no run replaces a packaged commit it did not mint; if the build is wrong, delete the tag by hand and rerun.";

/** sourceSha's packaged commit under its build tag: this checkout's build `tree` as the source's child, minted once.
 * Both parts of the name are the commit's own, so every run for one commit names one tag. */
function ensurePackaged(cwd: string, sourceSha: string, tree: string, runUrl?: string): EnsuredTag {
  const ref = `${BUILD_TAG_PREFIX}${mainPosition(cwd, sourceSha).count}.${sourceSha.slice(0, 7)}`;
  return ensureTag(
    cwd,
    ref,
    sourceSha,
    () =>
      gitWithEnv(
        cwd,
        BOT_IDENTITY,
        "commit-tree",
        "-p",
        sourceSha,
        "-m",
        `build: main at ${git(cwd, "rev-parse", "--short", sourceSha)}`,
        ...(runUrl === undefined ? [] : ["-m", `Workflow-run: ${runUrl}`]),
        tree,
      ),
    (peeled) => assertPackageOf(cwd, peeled, sourceSha, `${ref} (${peeled})`, BUILD_REMEDY, tree),
  );
}

/** The build tags beyond the `keep` newest by position, deleted in one push. Two runs pruning at once commute: the
 * server answers the deletion of a ref a rival deleted first with a warning, not a refusal. A ref under build/ this
 * pipeline would not name stops the prune: sorted in, it could push a genuine tag out of the window. */
export function pruneBuildTags(cwd: string, keep = KEPT_BUILD_TAGS): string[] {
  const refs = git(cwd, "ls-remote", "origin", `${BUILD_TAG_PREFIX}*`)
    .split("\n")
    .map((line) => line.split("\t")[1] ?? "")
    .filter((ref) => ref !== "" && !ref.endsWith("^{}"))
    .map((ref) => {
      const position = Number(ref.match(BUILD_TAG)?.[1]);
      if (Number.isNaN(position)) {
        throw new Error(
          `origin holds ${ref}, which is not a build/<position>.<sha7> tag this pipeline names; delete it by hand.`,
        );
      }
      return { ref, position };
    })
    .sort((a, b) => b.position - a.position || a.ref.localeCompare(b.ref))
    .slice(keep)
    .map((tag) => tag.ref);
  if (refs.length > 0) {
    git(cwd, "push", "origin", ...refs.map((ref) => `:${ref}`));
  }
  return refs;
}

export interface PointerMove {
  ref: string;
  /** Where the pointer is when the move ends. */
  sha: string;
  changed: boolean;
  reason: string;
}

/**
 * The one way a pointer (latest, vX) moves: forward along main, never back. A pointer's source is its commit's
 * parent when that parent is on main; the candidate's source is on main by its caller's check.
 *
 *   pointer's source is the candidate's or descends from it  -> left: the same package (another commit of it too), or a rerun of an older commit's run
 *   same source, another tree                                -> refused: two builds of one main commit
 *   pointer's source unknown (off main, a root)              -> moved: a value this pipeline did not mint
 *   otherwise                                                -> moved, under a lease on the value observed
 *
 * A value left in place must be a package of the commit it is read as packaging, or a hand-pushed bare child of a
 * newer commit would stand as "already past". Main's head is read AFTER the pointer on every pass: a pointer a rival
 * moved to a newer commit's package has that commit on main by then. A lease lost to a rival re-observes and
 * decides again; a push refused with the ref unmoved is thrown.
 */
export function movePointer(cwd: string, ref: string, candidate: Packaged): PointerMove {
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
    const observed = observeRemote(cwd, ref);
    const at = observed.peeled;
    if (observed.id !== "") {
      if (!fetchObserved(cwd, ref, observed.id)) {
        continue;
      }
      const mainHead = fetchMainHead(cwd);
      const parents = git(cwd, "log", "-1", "--format=%P", at).split(" ").filter(Boolean);
      const current = parents.length === 1 ? parents[0] : undefined;
      // A pointer whose commit is no child of a main commit (the retired chain's tip, a hand-pushed bare root) is replaced, not judged.
      if (current !== undefined && isAncestor(cwd, current, mainHead)) {
        if (isAncestor(cwd, candidate.source, current)) {
          assertPackageOf(cwd, at, current, `${ref} (${at})`, "inspect it by hand.");
          if (
            current === candidate.source &&
            git(cwd, "rev-parse", `${at}^{tree}`) !==
              git(cwd, "rev-parse", `${candidate.commit}^{tree}`)
          ) {
            throw new Error(
              `${ref} is at ${at}, another package of ${candidate.source} than ${candidate.commit} with another tree; two builds of one main commit exist - inspect both by hand.`,
            );
          }
          return {
            ref,
            sha: at,
            changed: false,
            reason: `${ref} already at ${at}, packaging ${current}, which is ${candidate.source} or past it`,
          };
        }
      }
    }
    const refused = push(
      cwd,
      `--force-with-lease=${ref}:${observed.id}`,
      "origin",
      `${candidate.commit}:${ref}`,
    );
    if (refused === null) {
      return {
        ref,
        sha: candidate.commit,
        changed: true,
        reason: `${ref}: moved to ${candidate.commit}${at === "" ? "" : ` from ${at}`}`,
      };
    }
    if (observeRemote(cwd, ref).id === observed.id) {
      throw refused;
    }
  }
  throw new Error(
    `could not move ${ref} after ${PUSH_ATTEMPTS} compare-and-swap attempts; something keeps moving it concurrently - rerun this job once it settles.`,
  );
}

interface PackageCommitOptions {
  cwd: string;
  /** The green main commit this run judged; the checkout must be at it with the bundle built. */
  sourceSha: string;
  /** Provenance trailer for a packaged commit this run mints (the workflow run URL). */
  runUrl?: string;
}

interface PackageCommitResult extends EnsuredTag {
  /** The build tags this run deleted, beyond the kept window. */
  pruned: string[];
  latest: PointerMove;
}

/** The green push's step: the commit's package under its build tag, the window pruned, latest moved forward. */
export function packageCommit(options: PackageCommitOptions): PackageCommitResult {
  const { cwd, sourceSha, runUrl } = options;
  assertFullHistory(
    cwd,
    "package-commit",
    "the commit's position on main and whether latest's source lies on its history cannot be judged on a truncated one.",
  );
  const tree = builtTree(cwd, sourceSha);
  assertOnMain(cwd, sourceSha, "package a commit main does not hold");
  const packaged = ensurePackaged(cwd, sourceSha, tree, runUrl);
  const pruned = pruneBuildTags(cwd);
  return { ...packaged, pruned, latest: movePointer(cwd, LATEST_REF, packaged) };
}

interface PackageOptions {
  cwd: string;
  tag: string;
  /** The release's merge commit, resolved from the draft (not necessarily this run's own push); the tag's recorded source. */
  sourceSha: string;
  /** Provenance trailer for a packaged commit this run has to mint (the workflow run URL). */
  runUrl?: string;
}

interface PackagedRelease {
  created: boolean;
  packagedSha: string;
  /** The build tags this run deleted, beyond the kept window. */
  pruned: string[];
  latest: PointerMove;
}

const FROZEN =
  "the release-tags ruleset freezes version tags, so no rerun can replace it - inspect it by hand.";

/**
 * Mint the release's version tag on its packaged commit exactly once; the checkout must be the merge commit with the
 * bundle freshly built. A rerun finds the tag on origin and holds it to this build instead, so no rerun can move or
 * replace a version tag, then prunes and reconciles latest as post-green does, healing a run that died between the
 * pushes (and giving @latest a value even where post-green cannot push).
 *
 *   source off origin's main          -> stop before any push: the frozen tag would be poisoned
 *   the build tag packages it         -> tagged there (normally minted by post-green earlier in this run)
 *   no build tag (pruned, or skipped) -> minted here through post-green's path; a package the window has moved past goes again at once
 */
export function packageRelease(options: PackageOptions): PackagedRelease {
  const { cwd, tag, sourceSha, runUrl } = options;
  releaseMajor(tag);
  assertFullHistory(
    cwd,
    "package",
    "the merge commit's position on main and whether latest's source lies on its history cannot be judged on a truncated one.",
  );
  const tree = builtTree(cwd, sourceSha);
  // A hand recovery with the wrong TAG, or a draft pointing at the wrong commit, must stop before an immutable tag is minted.
  const manifest = manifestVersionAt(cwd, "HEAD");
  if (tag !== `v${manifest}`) {
    throw new Error(
      `tag ${tag} does not match the manifest version ${JSON.stringify(manifest)} at ${sourceSha}; refusing to package a version this source did not release.`,
    );
  }
  assertOnMain(cwd, sourceSha, "package, tag, or publish a commit main does not hold");
  const ref = `refs/tags/${tag}`;
  const tagged = ensureTag(
    cwd,
    ref,
    sourceSha,
    () => ensurePackaged(cwd, sourceSha, tree, runUrl).commit,
    (peeled) => assertPackageOf(cwd, peeled, sourceSha, `${ref} (${peeled})`, FROZEN, tree),
  );
  const pruned = pruneBuildTags(cwd);
  return {
    created: tagged.created,
    packagedSha: tagged.commit,
    pruned,
    latest: movePointer(cwd, LATEST_REF, tagged),
  };
}

interface RetagMajorOptions {
  cwd: string;
  tag: string;
  sourceSha: string;
}

interface RetaggedMajor {
  major: string;
  packagedSha: string;
  move: PointerMove;
}

/** The version tag is read from origin afresh and judged from its objects alone (the byte check against a fresh
 * build was package's, a step earlier); the major then moves through movePointer, so a rerun of an old release's
 * job leaves a newer release's major where it is. */
export function retagMajor(options: RetagMajorOptions): RetaggedMajor {
  const { cwd, tag, sourceSha } = options;
  assertFullHistory(
    cwd,
    "retag-major",
    "whether the release and the major's current source lie on main cannot be judged on a truncated one.",
  );
  const ref = `refs/tags/${tag}`;
  git(cwd, "fetch", "--quiet", ...TAG_FETCH, "origin", `+${ref}:${ref}`);
  const packagedSha = git(cwd, "rev-parse", `${ref}^{}`);
  assertOnMain(cwd, sourceSha, "bless a release main does not hold");
  assertPackageOf(cwd, packagedSha, sourceSha, `${ref} (${packagedSha})`, FROZEN);
  const major = releaseMajor(tag);
  const move = movePointer(cwd, `refs/tags/${major}`, { commit: packagedSha, source: sourceSha });
  return { major, packagedSha, move };
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

/** The manifest's version at a commit: what release-please last released, or is about to. */
function manifestVersionAt(cwd: string, treeish: string): string {
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

/**
 * The npm version a green main commit's library build publishes under the `next` dist-tag: the manifest version's
 * next patch, then `main`, the source's position on main, and its short sha. That sorts above the last release,
 * below the next one whatever its bump, and along main: npm compares the count first, and it grows by one with
 * each merge (the date is for the reader; two merges on one day share it). The sha carries a `g` prefix, as git
 * describe writes it: npm reads an all-digit identifier as a number and drops its leading zero, so a bare sha7
 * such as 0123456 would be rewritten to 123456 and name no commit.
 */
export function prereleaseVersion(
  manifestVersion: string,
  position: MainPosition,
  sourceSha: string,
): string {
  const version = manifestVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!version) {
    throw new Error(
      `the manifest version ${JSON.stringify(manifestVersion)} is not X.Y.Z; refusing to derive a pre-release version from it.`,
    );
  }
  // The first commit counts 1, so a count of 0 names no commit; a version carrying one was never minted here.
  if (!Number.isInteger(position.count) || position.count < 1) {
    throw new Error(
      `the commit count ${JSON.stringify(position.count)} is not a positive integer; refusing to mint a pre-release version from it.`,
    );
  }
  if (!FULL_SHA.test(sourceSha)) {
    throw new Error(
      `the source ${JSON.stringify(sourceSha)} is not a full commit sha; refusing to mint a pre-release version from it.`,
    );
  }
  const [, major, minor, patch] = version;
  return `${major}.${minor}.${Number(patch) + 1}-main.${position.count}.${position.date}.g${sourceSha.slice(0, 7)}`;
}

export interface PrereleaseVersionOptions {
  cwd: string;
  /** The green main commit this run judged; the checkout must be at it. */
  sourceSha: string;
}

/** The checkout must be at the source whose build is published: the manifest and package.json are read there. */
function assertCheckoutAt(cwd: string, sourceSha: string): void {
  const head = git(cwd, "rev-parse", "HEAD");
  if (head !== sourceSha) {
    throw new Error(
      `the checkout is at ${head}, not the source commit ${sourceSha} whose build is published.`,
    );
  }
}

export function prereleaseVersionOf(options: PrereleaseVersionOptions): string {
  const { cwd, sourceSha } = options;
  assertCheckoutAt(cwd, sourceSha);
  return prereleaseVersion(
    manifestVersionAt(cwd, sourceSha),
    mainPosition(cwd, sourceSha),
    sourceSha,
  );
}

/** A version this pipeline mints, parsed: a release, or a pre-release carrying its source's short sha. The
 * identifiers between `main` and the sha are not read back: a published pre-release is placed by its source's
 * ancestry, never by comparing them. */
interface MintedVersion {
  release: [number, number, number];
  sha7: string | null;
}

function mintedVersion(version: string): MintedVersion | null {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-main\.(?:(?:0|[1-9]\d*)\.)+g([0-9a-f]{7}))?$/,
  );
  if (!match) {
    return null;
  }
  const [, major = "", minor = "", patch = "", sha7 = null] = match;
  return { release: [Number(major), Number(minor), Number(patch)], sha7 };
}

/** A version a dist-tag names must be one this pipeline mints; anything else stops the run rather than being guessed at. */
function parseMinted(version: string): MintedVersion {
  const minted = mintedVersion(version);
  if (minted === null) {
    throw new Error(
      `${JSON.stringify(version)} is not a version this pipeline mints (X.Y.Z or X.Y.Z-main.<position>.g<sha7>); refusing to order it.`,
    );
  }
  return minted;
}

/** Whether release `a` sorts above `b`: by major, minor, patch. */
function newerRelease(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

/** What the registry holds for the package: every published version, and where each dist-tag points. */
export interface Packument {
  versions: Record<string, unknown>;
  "dist-tags": Record<string, string>;
}

export type PublishVerdict =
  | { publish: true; version: string }
  | { publish: false; version: string; reason: string };
/** The next channel's verdict also carries, one line each, the published pre-releases it set aside: a source the checkout cannot place. */
export type NextVerdict = PublishVerdict & { notices: string[] };

/** A published pre-release whose source is a strict descendant of this run's: newer on main, whatever its numbers say. */
interface Descendant {
  version: string;
  /** The full sha the version's sha7 resolved to. */
  sha: string;
}

/** The published pre-releases placed against this run's source by ancestry: the descendants, the one furthest along
 * main, and a notice for each the checkout cannot place (a sha it lacks, or one off the source's line of main). */
function descendantsOf(
  cwd: string,
  sourceSha: string,
  packument: Packument,
): { descendants: Descendant[]; newest: Descendant | null; notices: string[] } {
  const descendants: Descendant[] = [];
  const notices: string[] = [];
  let newest: Descendant | null = null;
  const descends = (ancestor: string, sha: string): boolean =>
    gitOrNo(cwd, "merge-base", "--is-ancestor", ancestor, sha) !== null;
  for (const version of Object.keys(packument.versions)) {
    const sha7 = mintedVersion(version)?.sha7;
    if (sha7 === null || sha7 === undefined) {
      continue;
    }
    const sha = resolveCommit(cwd, sha7);
    if (sha === null) {
      notices.push(`${version} names ${sha7}, which is no commit in this checkout; ignored`);
    } else if (sha !== sourceSha && descends(sourceSha, sha)) {
      descendants.push({ version, sha });
      if (newest === null || descends(newest.sha, sha)) {
        newest = { version, sha };
      }
    } else if (sha !== sourceSha && !descends(sha, sourceSha)) {
      notices.push(
        `${version} names ${sha7}, which is neither an ancestor nor a descendant of ${sourceSha.slice(0, 7)} on main; ignored`,
      );
    }
  }
  return { descendants, newest, notices };
}

/**
 * Every published pre-release is placed by its source's ancestry, so a run for an older commit publishes nothing
 * once a newer commit's pre-release is on the registry, whatever order the two runs finished in (`npm publish --tag
 * next` moves next to whatever it publishes). The dist-tags need no separate read: whatever next names is among
 * the versions. Null is a package the registry has never seen: the first publish goes.
 */
export function nextPublishVerdict(
  cwd: string,
  sourceSha: string,
  version: string,
  packument: Packument | null,
): NextVerdict {
  if (packument === null) {
    return { publish: true, version, notices: [] };
  }
  if (version in packument.versions) {
    return {
      publish: false,
      version,
      reason: `${version} is already on the registry`,
      notices: [],
    };
  }
  const { newest: newer, notices } = descendantsOf(cwd, sourceSha, packument);
  if (newer !== null) {
    return {
      publish: false,
      version,
      reason: `the registry already holds ${newer.version}, whose source ${newer.sha.slice(0, 7)} is a descendant of ${sourceSha.slice(0, 7)} on main, so this stale run publishes nothing (npm publish --tag next would move next back)`,
      notices,
    };
  }
  return { publish: true, version, notices };
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
    return {
      publish: false,
      version,
      reason: `${version} is already on the registry`,
    };
  }
  const latest = packument["dist-tags"].latest;
  // Until the first release, latest names a pre-release: a packument always carries that key (npm/registry
  // REGISTRY-API.md, "dist-tags: an object with at least one key, latest"), so the first publish took it whatever
  // --tag asked for. A release must take latest over from it, so only a newer RELEASE holds one back.
  const held = latest === undefined ? null : parseMinted(latest);
  if (held?.sha7 === null && newerRelease(held.release, parseMinted(version).release)) {
    return {
      publish: false,
      version,
      reason: `the registry's latest is ${latest}, newer than ${version}, so this rerun of an older release publishes nothing (npm publish would move latest back)`,
    };
  }
  return { publish: true, version };
}

/** The registry's record of `name`, or null while it has never been published; any other answer than 200 or 404 throws.
 * The URL carries a fresh query string on every read: the registry's CDN serves a packument from cache for up to
 * 300 s (cache-control: public, max-age=300, and a request's no-cache is ignored), and a cache key that no earlier
 * request had misses it, so the record comes from the origin, a publish just landed included. */
async function fetchPackument(registry: string, name: string): Promise<Packument | null> {
  const url = `${registry.replace(/\/$/, "")}/${name.replaceAll("/", "%2F")}`;
  const response = await fetch(
    `${url}?fresh=${Date.now()}-${Math.random().toString(36).slice(2)}`,
    {
      headers: { accept: "application/json" },
    },
  );
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
} & ({ channel: "next" } | { channel: "stable"; tag: string });

export async function npmVerdict(
  options: NpmVerdictOptions,
): Promise<NextVerdict | PublishVerdict> {
  const { cwd, sourceSha, registry } = options;
  let version: string;
  if (options.channel === "next") {
    version = prereleaseVersionOf({ cwd, sourceSha });
  } else {
    assertCheckoutAt(cwd, sourceSha);
    version = releaseVersionAt(cwd, "HEAD", options.tag);
  }
  const packument = await fetchPackument(registry, packageFieldAt(cwd, "HEAD", "name"));
  return options.channel === "next"
    ? nextPublishVerdict(cwd, sourceSha, version, packument)
    : stablePublishVerdict(version, packument);
}

export type ConfirmVerdict =
  /** The registry's record shows the version this run published, and next names no older pre-release than it should. */
  | { outcome: "settled"; version: string; reads: number }
  /** The record still lacks the version after every read: a following run may read one without it. */
  | { outcome: "unsettled"; version: string; reason: string }
  /** The record shows the version and a pre-release of a descendant, and next names neither that nor a later one. */
  | { outcome: "behind"; version: string; reason: string };

export interface NpmConfirmOptions {
  cwd: string;
  /** The commit whose build this run published; the checkout must be at it. */
  sourceSha: string;
  /** The registry's base URL, where the package's record is read. */
  registry: string;
  /** How many times the record is read while it lacks the version, and the pause between reads. */
  attempts: number;
  delayMs: number;
}

/**
 * After `npm publish --tag next`: the record is read until it shows the version, so the job holds the npm-publish
 * lane until the next holder's verdict can see this publish (npm makes a publish readable asynchronously; a verdict
 * read in that gap would move next back). Once it shows, and a descendant's pre-release is on the record, next
 * must name a descendant's, or this stale run moved it back. A drift is reported, not repaired: trusted publishing (OIDC)
 * authenticates `npm publish` alone, not `npm dist-tag add` (npm/cli#8547); the next green push's publish moves
 * next forward, and a rerun of the reporting run publishes nothing and passes, so a blocked release can go on.
 */
export async function npmConfirm(options: NpmConfirmOptions): Promise<ConfirmVerdict> {
  const { cwd, sourceSha, registry, attempts, delayMs } = options;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`the read attempts must be a positive integer, not ${attempts}`);
  }
  const version = prereleaseVersionOf({ cwd, sourceSha });
  const name = packageFieldAt(cwd, "HEAD", "name");
  for (let read = 1; ; read++) {
    // A read that fails counts as a read that did not show the version: the lane is held through the budget
    // either way, and the last failure is the one reported.
    let packument: Packument | null;
    try {
      packument = await fetchPackument(registry, name);
    } catch (error) {
      if (read === attempts) {
        throw error;
      }
      await sleep(delayMs);
      continue;
    }
    if (packument !== null && version in packument.versions) {
      const { descendants, newest } = descendantsOf(cwd, sourceSha, packument);
      const next = packument["dist-tags"].next;
      if (newest !== null && !descendants.some((descendant) => descendant.version === next)) {
        return {
          outcome: "behind",
          version,
          reason:
            `the registry's next is ${next ?? "unset"} while it holds ${newest.version}, whose source ${newest.sha.slice(0, 7)} ` +
            `is a descendant of ${sourceSha.slice(0, 7)} on main; this stale run moved next back, and the next green push ` +
            `moves it forward (npm dist-tag add ${name}@${newest.version} next repairs it by hand)`,
        };
      }
      return { outcome: "settled", version, reads: read };
    }
    if (read === attempts) {
      return {
        outcome: "unsettled",
        version,
        reason: `the registry's record still lacks ${version} after ${attempts} reads over ${Math.round(((attempts - 1) * delayMs) / 1000)} s; a run judged before it shows may move next back, and the green push after it moves next forward`,
      };
    }
    await sleep(delayMs);
  }
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** 15 reads 20 s apart (up to 280 s): three of the first five publishes were still unreadable after 80 s. */
const CONFIRM_READS = 15;
const CONFIRM_PAUSE_MS = 20_000;

/** The pause between confirm reads: NPM_CONFIRM_PAUSE_MS when set (a test confirms against a local registry without the wait), else CONFIRM_PAUSE_MS. */
function confirmPauseMs(value: string | undefined): number {
  if (value === undefined || value === "") {
    return CONFIRM_PAUSE_MS;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `NPM_CONFIRM_PAUSE_MS must be a whole number of milliseconds, not ${JSON.stringify(value)}`,
    );
  }
  return Number(value);
}

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
        `${result.created ? "created" : "verified"} ${env("TAG")} on packaged commit ${result.packagedSha}; ${result.pruned.length === 0 ? "no build tag beyond the window" : `pruned ${result.pruned.join(", ")}`}; ${result.latest.reason}`,
      );
      break;
    }
    case "retag-major": {
      const result = retagMajor({ cwd, tag: env("TAG"), sourceSha: env("GITHUB_SHA") });
      console.error(result.move.reason);
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
    case "package-commit": {
      const result = packageCommit({
        cwd,
        sourceSha: env("GITHUB_SHA"),
        runUrl: process.env.RUN_URL,
      });
      console.error(
        `${result.ref}${result.created ? ": created at" : " already packages the commit at"} ${result.commit}; ${result.pruned.length === 0 ? "no build tag beyond the window" : `pruned ${result.pruned.join(", ")}`}; ${result.latest.reason}`,
      );
      break;
    }
    case "prerelease-version": {
      console.log(prereleaseVersionOf({ cwd, sourceSha: env("GITHUB_SHA") }));
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
        ...(argument === "next" ? { channel: argument } : { channel: argument, tag: env("TAG") }),
      });
      for (const notice of "notices" in verdict ? verdict.notices : []) {
        console.error(notice);
      }
      console.log(verdict.publish ? `publish ${verdict.version}` : `skip ${verdict.reason}`);
      break;
    }
    case "npm-confirm": {
      if (argument !== "next") {
        throw new Error(
          `npm-confirm takes the channel, next, not ${JSON.stringify(argument ?? null)}`,
        );
      }
      const confirmed = await npmConfirm({
        cwd,
        sourceSha: env("GITHUB_SHA"),
        registry: process.env.NPM_REGISTRY_URL || DEFAULT_REGISTRY,
        attempts: CONFIRM_READS,
        delayMs: confirmPauseMs(process.env.NPM_CONFIRM_PAUSE_MS),
      });
      console.log(
        confirmed.outcome === "settled"
          ? `settled ${confirmed.version} is on the registry after ${confirmed.reads} ${confirmed.reads === 1 ? "read" : "reads"}; next is not behind a descendant's pre-release`
          : `${confirmed.outcome} ${confirmed.reason}`,
      );
      break;
    }
    default:
      throw new Error(
        `unknown command ${JSON.stringify(command ?? null)}; expected package | retag-major | anchor | boundary-check | anchor-check | package-commit | prerelease-version | npm-verdict | npm-confirm`,
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
