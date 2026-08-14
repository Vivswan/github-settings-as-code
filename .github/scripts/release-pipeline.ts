/**
 * The single-tag release pipeline's git topology, called step by step from
 * .github/workflows/release.yml and unit-tested against local fixture
 * repositories (test/scripts/release-pipeline.test.ts), so "the next release
 * tags the right commits" is proven on every push instead of on release day.
 *
 * The scheme: main is source-only, and every ref a consumer can name - the
 * vX.Y.Z release tags and the moving major vX - points ONLY at a packaged
 * commit, a child of the release-please merge commit that adds the built
 * lib/index.js. Subcommands, one per workflow step:
 *
 *   detect       GITHUB_OUTPUT lines (tag=/version=) when this push merges a
 *                release-please PR - the .release-please-manifest.json diff
 *                cross-checked against the merge subject, throwing on any
 *                ambiguity so a hand-edited manifest can never mint a tag -
 *                and empty values on an ordinary push.
 *   notes <ver>  The CHANGELOG.md section for <ver> on stdout.
 *   package      Create the packaged child of GITHUB_SHA and tag it ONCE,
 *                or byte-verify an existing tag (idempotent rerun). No path
 *                moves a tag.
 *   retag-major  Re-verify the version tag against origin, then force-move
 *                the major tag to its packaged commit - never backward to an
 *                older release than the line already shipped.
 *   verify       Confirm origin's ACTUAL refs: the version tag and its major
 *                both point at the packaged child of the merge commit, and
 *                that commit's tree carries a non-empty lib/index.js.
 *   anchor       Advance last-release-sha in release-please-config.json on
 *                main to the merge commit. Load-bearing: version tags live
 *                on packaged children that are NOT on main, and
 *                release-please's commit walk only sees main, so without the
 *                anchor the next release PR would count every commit since
 *                the previous boundary - stale changelog, wrong version.
 *   boundary-check
 *                Fail unless last-release-sha matches the newest release
 *                merge on the checked-out history: a failed anchor (or a
 *                release merge that slipped past detection) stays loud on
 *                EVERY push, and release-please stays gated, instead of
 *                quietly building garbage release PRs from a stale boundary.
 *
 * Env: TAG and GITHUB_SHA (package/retag-major/anchor), RUN_URL (package,
 * optional provenance trailer). Node builtins only, so `bun` runs it before
 * any install.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILE = ".release-please-manifest.json";
const CONFIG_FILE = "release-please-config.json";
const BUNDLE_FILE = "lib/index.js";
/** What a squash-merged release-please PR's subject looks like on main. */
const RELEASE_SUBJECT = /^chore\(main\): release (\d+\.\d+\.\d+)(?: \(#\d+\))?$/;

/** Run git in cwd, returning trimmed stdout; rethrows with the command and
 * its stderr so a CI failure names the git call that produced it. */
function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? `: ${stderr.trim()}` : "";
    throw new Error(`git ${args.join(" ")} failed${detail}`);
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

export interface DetectedRelease {
  version: string;
  tag: string;
}

/**
 * Decide whether HEAD is the merge of a release-please PR. The manifest diff
 * alone is not proof (the file is repo-owned and hand-editable), so the
 * version step must agree with the merge subject; disagreement throws rather
 * than guessing, and nothing downstream tags anything.
 */
export function detectRelease(cwd: string): DetectedRelease | null {
  if (tryGit(cwd, "rev-parse", "--verify", "--quiet", "HEAD^") === null) {
    return null; // root commit: nothing was merged onto anything
  }
  const changed = git(cwd, "diff", "--name-only", "HEAD^", "HEAD").split("\n");
  if (!changed.includes(MANIFEST_FILE)) {
    return null;
  }
  const manifest = JSON.parse(git(cwd, "show", `HEAD:${MANIFEST_FILE}`)) as Record<string, unknown>;
  const keys = Object.keys(manifest);
  if (keys.length !== 1 || keys[0] !== ".") {
    throw new Error(
      `${MANIFEST_FILE} at HEAD tracks [${keys.join(", ")}], not exactly the root package "."; refusing to tag until the manifest shape is understood.`,
    );
  }
  const version = manifest["."];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `${MANIFEST_FILE} at HEAD has version ${JSON.stringify(version)}, not an X.Y.Z release; refusing to tag.`,
    );
  }
  const beforeRaw = tryGit(cwd, "show", `HEAD^:${MANIFEST_FILE}`);
  const before = beforeRaw === null ? {} : (JSON.parse(beforeRaw) as Record<string, unknown>);
  if (before["."] === version) {
    console.error(
      `${MANIFEST_FILE} changed without a version step (still ${version}); not a release.`,
    );
    return null;
  }
  const subject = git(cwd, "log", "-1", "--format=%s");
  const merged = subject.match(RELEASE_SUBJECT);
  if (merged === null) {
    throw new Error(
      `${MANIFEST_FILE} stepped to ${version} but the commit subject is "${subject}", not a release-please merge; refusing to tag. Revert the hand edit, or release through a release-please PR.`,
    );
  }
  if (merged[1] !== version) {
    throw new Error(
      `the merge subject releases ${merged[1]} but ${MANIFEST_FILE} says ${version}; refusing to tag a version the release PR did not cut.`,
    );
  }
  return { version, tag: `v${version}` };
}

/**
 * The CHANGELOG.md section for one version: from its "## " heading (linked
 * "## [X.Y.Z](...)" or bare "## X.Y.Z (date)") to the next version heading.
 */
export function extractReleaseNotes(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  // Full metacharacter escape: the version reaches this regex from the CLI,
  // and only literal-match semantics are ever intended.
  const literal = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## \\[?${literal}[\\]) ]`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    throw new Error(
      `CHANGELOG.md has no "## ${version}" section; the release PR should have written it.`,
    );
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return `${lines.slice(start, end).join("\n").trim()}\n`;
}

/**
 * The invariant every tagged ref must satisfy before consumers can be
 * pointed at it: the commit's TREE carries a non-empty bundle. Asserted on
 * every path that mints or blesses a ref - fresh package (before the tag
 * push), rerun verification, and the major move - not derived from diffs.
 */
function assertCarriesBundle(cwd: string, sha: string): void {
  const size = tryGit(cwd, "cat-file", "-s", `${sha}:${BUNDLE_FILE}`);
  if (size === null || Number(size) === 0) {
    throw new Error(
      `commit ${sha} does not carry a non-empty ${BUNDLE_FILE}; refusing to point a version ref at an unpackaged commit.`,
    );
  }
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
  const head = git(cwd, "rev-parse", "HEAD");
  if (head !== sourceSha) {
    throw new Error(`the checkout is at ${head}, not the release merge commit ${sourceSha}.`);
  }
  if (!existsSync(join(cwd, BUNDLE_FILE))) {
    throw new Error(`${BUNDLE_FILE} is not built; run the build before packaging.`);
  }
  const ref = `refs/tags/${tag}`;
  // A standalone git() propagates a failing ls-remote, so a transport error
  // cannot read as "the tag does not exist".
  const existing = git(cwd, "ls-remote", "origin", ref);
  if (existing !== "") {
    git(cwd, "fetch", "--quiet", "--depth=2", "origin", `+${ref}:${ref}`);
    return { created: false, packagedSha: verifyPackagedTag(cwd, tag, sourceSha) };
  }
  // The packaged commit freezes the whole index, so nothing beyond the
  // bundle may be pending: a dirty by-hand checkout would otherwise bake
  // unrelated changes into an immutable tag. The bundle itself is
  // gitignored and never appears here.
  const dirty = git(cwd, "status", "--porcelain").split("\n").filter(Boolean);
  if (dirty.length > 0) {
    throw new Error(
      `the worktree has pending changes beyond ${BUNDLE_FILE} (${dirty.join("; ")}); a packaged commit must add ONLY the bundle - commit, stash, or clean them first.`,
    );
  }
  configureIdentity(cwd);
  git(cwd, "add", "-f", BUNDLE_FILE); // -f: main gitignores the bundle
  const message = ["-m", `build: package ${tag}`, "-m", `source: ${sourceSha}`];
  if (runUrl !== undefined) {
    message.push("-m", `workflow run: ${runUrl}`);
  }
  git(cwd, "commit", ...message);
  const packagedSha = git(cwd, "rev-parse", "HEAD");
  const committed = git(cwd, "diff", "--name-only", sourceSha, packagedSha)
    .split("\n")
    .filter(Boolean);
  if (committed.length !== 1 || committed[0] !== BUNDLE_FILE) {
    throw new Error(
      `the packaged commit would change [${committed.join(", ")}], not only ${BUNDLE_FILE}; refusing to push it.`,
    );
  }
  assertCarriesBundle(cwd, packagedSha);
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
  const changed = git(cwd, "diff", "--name-only", parent, packagedSha).split("\n").filter(Boolean);
  if (changed.length !== 1 || changed[0] !== BUNDLE_FILE) {
    throw new Error(
      `refs/tags/${tag} changes more than ${BUNDLE_FILE} relative to ${sourceSha} (changed: ${changed.join(", ")}); ${frozen}`,
    );
  }
  const tagged = gitBytes(cwd, "show", `${packagedSha}:${BUNDLE_FILE}`);
  if (!tagged.equals(readFileSync(join(cwd, BUNDLE_FILE)))) {
    throw new Error(
      `refs/tags/${tag} carries a ${BUNDLE_FILE} that is not a build of ${sourceSha}'s source; ${frozen}`,
    );
  }
  assertCarriesBundle(cwd, packagedSha);
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
  const packagedSha = git(cwd, "rev-parse", `${ref}^{}`);
  const parent = git(cwd, "rev-parse", `${packagedSha}^`);
  if (parent !== sourceSha) {
    throw new Error(
      `refs/tags/${tag}'s parent is ${parent}, not this release's merge commit ${sourceSha}; the major tag must not move to a package of the wrong source - inspect that tag by hand.`,
    );
  }
  assertCarriesBundle(cwd, packagedSha);
  const major = `v${tag.slice(1).split(".")[0]}`;
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
  const major = `v${tag.slice(1).split(".")[0]}`;
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

const RELEASE_PR_BRANCH = "release-please--branches--main";

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
 * release-please branch setting last-release-sha to main's current head -
 * the future merge commit's PARENT, known now, unlike the merge SHA. The
 * squash merge then lands the correct boundary on main as part of the
 * release itself: no push to main, no admin credential. Correctness rides
 * on the release-freshness gate (a release PR must contain main's tip to
 * merge, so the recorded parent cannot be stale at merge time). The parent
 * is as good a boundary as the merge commit: the walk then includes the
 * merge itself, a chore commit the changelog hides.
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
    git(cwd, "fetch", "--quiet", "--force", "origin", `+${branchRef}:${branchRef}`);
    git(cwd, "checkout", "--quiet", "--force", RELEASE_PR_BRANCH);
    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8")) as Record<
      string,
      unknown
    >;
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
    try {
      git(cwd, "push", "origin", `HEAD:${branchRef}`);
      return { changed: true, reason: `anchored ${RELEASE_PR_BRANCH} at ${sourceSha}` };
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
 * detection) and every release PR refresh would be computed from a stale
 * boundary. Loud and gating beats silently wrong changelogs.
 */
export function boundaryCheck(cwd: string): { boundary: string } {
  const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8")) as {
    "last-release-sha"?: unknown;
    packages?: Record<string, { "release-as"?: unknown }>;
  };
  // A release-as pin equal to the shipped version means someone forgot to
  // remove it after its release: release-please would propose that version
  // forever and releases would silently stop.
  const releaseAs = config.packages?.["."]?.["release-as"];
  if (releaseAs !== undefined) {
    const manifest = JSON.parse(readFileSync(join(cwd, MANIFEST_FILE), "utf8")) as Record<
      string,
      unknown
    >;
    if (releaseAs === manifest["."]) {
      throw new Error(
        `release-as ${JSON.stringify(releaseAs)} in ${CONFIG_FILE} equals the shipped version in ${MANIFEST_FILE}; it did its job - remove it, or no further release will ever be proposed.`,
      );
    }
  }
  const latest = git(cwd, "log", "--grep", "^chore(main): release ", "-1", "--format=%H");
  const recorded = config["last-release-sha"];
  if (latest === "") {
    return { boundary: "none (no release merge on this history yet)" };
  }
  const parent = tryGit(cwd, "rev-parse", `${latest}^`);
  if (recorded === latest || (parent !== null && recorded === parent)) {
    return { boundary: String(recorded) };
  }
  throw new Error(
    `last-release-sha in ${CONFIG_FILE} is ${JSON.stringify(recorded)}, but the newest release merge on main is ${latest} (parent ${parent}); release PR refreshes would be computed from a stale boundary. Fix by PR: set last-release-sha to ${parent ?? latest}.`,
  );
}

if (import.meta.main) {
  const cwd = process.cwd();
  const [command, argument] = process.argv.slice(2);
  const env = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} is required for "${command}"`);
    }
    return value;
  };
  try {
    switch (command) {
      case "detect": {
        const release = detectRelease(cwd);
        // Always both lines: the workflow's `tag != ''` guards need the
        // output defined. Nothing else may print to stdout - the caller
        // redirects it to GITHUB_OUTPUT.
        process.stdout.write(`tag=${release?.tag ?? ""}\nversion=${release?.version ?? ""}\n`);
        console.error(
          release === null
            ? "no release-please merge on this push"
            : `this push merged the release PR for ${release.tag}`,
        );
        break;
      }
      case "notes": {
        if (argument === undefined) {
          throw new Error("usage: release-pipeline.ts notes <version>");
        }
        process.stdout.write(
          extractReleaseNotes(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"), argument),
        );
        break;
      }
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
      default:
        throw new Error(
          `unknown command ${JSON.stringify(command ?? null)}; expected detect | notes | package | retag-major | verify | anchor | boundary-check`,
        );
    }
  } catch (error) {
    console.error(
      `release-pipeline ${command ?? ""}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
