/**
 * The packaged commits and the refs that name them: a main commit's package under its build tag, the version tag
 * minted once on the release's package, and the pointers (latest, vX) that move forward along main alone. Every
 * push is a create-once or a lease, judged by re-reading origin, never by git's words.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  assertFullHistory,
  BOT_IDENTITY,
  git,
  gitWithEnv,
  isAncestor,
  mainPosition,
  manifestVersionAt,
  push,
  tryGit,
} from "./git.js";

const MANIFEST = "package.json";
/** What a packaged commit carries beyond its source (a directory entry stages every file under it). */
const PACKAGED_PATHS = ["lib/index.js", "lib/settings.schema.json", "lib/pkg/"] as const;
/** What every packaged commit must carry as non-empty regular files. */
const REQUIRED_BUILT_FILES = [
  "lib/index.js",
  "lib/settings.schema.json",
  "lib/pkg/index.js",
] as const;
const PACKAGED = "lib/index.js, lib/settings.schema.json, and lib/pkg/";
const LATEST_REF = "refs/tags/latest";
const BUILD_TAG_PREFIX = "refs/tags/build/";
const BUILD_TAG = /^refs\/tags\/build\/([1-9]\d*)\.[0-9a-f]{7}$/;
/** How many build tags stay; releases and latest keep their own commits. */
export const KEPT_BUILD_TAGS = 10;
/** Never --depth: a depth-limited fetch marks the commit it lands on shallow and cuts the parent link every package
 * check reads. Blobs arrive on demand, or with the commit on a server without filter support. */
const TAG_FETCH = ["--filter=blob:none"];

const PUSH_ATTEMPTS = 3;

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
 * A value left in place must be a package of the commit it is read as packaging, or a hand-pushed bare child of a
 * newer commit would stand as "already past". Main's head is read AFTER the pointer on every pass: a pointer a rival
 * moved to a newer commit's package has that commit on main by then.
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

export const FROZEN =
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
