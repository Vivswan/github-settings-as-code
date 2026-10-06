/**
 * The npm side of the pipeline: the pre-release version a main commit mints, the publish verdicts read from the
 * registry's record, the publish itself with the confirmation that holds the lane, and the npm floor trusted
 * publishing needs.
 */

import { execFileSync, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  FULL_SHA,
  git,
  gitOrNo,
  type MainPosition,
  mainPosition,
  manifestVersionAt,
  resolveCommit,
} from "./git.js";

/**
 * The npm version a main commit's library build publishes under the `next` dist-tag: the manifest version's
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
  /** The commit whose build is published; the checkout must be at it. */
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

/** The source sha7 a pre-release this pipeline minted carries; null for a release or a version minted elsewhere. */
const sha7Of = (version: string): string | null => mintedVersion(version)?.sha7 ?? null;

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
/** The next channel's guard also carries, one line each, the published pre-releases it set aside: a source the checkout cannot place. */
export type NextVerdict = PublishVerdict & { notices: string[] };

/** A published pre-release whose source is a strict descendant of this run's: newer on main, whatever its numbers say. */
interface Descendant {
  version: string;
  /** The full sha the version's sha7 resolved to. */
  sha: string;
}

/**
 * Where a pre-release's source stands to this run's, once its sha resolves: the run's own commit, an ancestor, a strict
 * descendant, or one on neither side of the source (off its line of main).
 */
type Placement = "own" | "ancestor" | "descendant" | "unrelated";
/** A source placed, or one the checkout lacks (a sha it never fetched, or a short one naming several objects). */
type Placed = { sha: string; placement: Placement } | { sha: null; placement: "unresolved" };

function placeSource(cwd: string, sourceSha: string, sha7: string): Placed {
  const sha = resolveCommit(cwd, sha7);
  if (sha === null) {
    return { sha, placement: "unresolved" };
  }
  const descends = (ancestor: string, descendant: string): boolean =>
    gitOrNo(cwd, "merge-base", "--is-ancestor", ancestor, descendant) !== null;
  if (sha === sourceSha) {
    return { sha, placement: "own" };
  }
  if (descends(sourceSha, sha)) {
    return { sha, placement: "descendant" };
  }
  return { sha, placement: descends(sha, sourceSha) ? "ancestor" : "unrelated" };
}

/**
 * The published pre-releases placed against this run's source by ancestry: the descendants, the one furthest along
 * main, and a notice for each the checkout cannot place. The version `next` names is placed with them, whether or not
 * the record lists it.
 */
function placePublished(
  cwd: string,
  sourceSha: string,
  packument: Packument,
): { descendants: Descendant[]; newest: Descendant | null; notices: string[] } {
  const descendants: Descendant[] = [];
  const notices: string[] = [];
  let newest: Descendant | null = null;
  const nextVersion = packument["dist-tags"].next;
  const versions = new Set(Object.keys(packument.versions));
  if (nextVersion !== undefined) {
    versions.add(nextVersion);
  }
  for (const version of versions) {
    const sha7 = sha7Of(version);
    if (sha7 === null) {
      continue;
    }
    const placed = placeSource(cwd, sourceSha, sha7);
    if (placed.sha === null) {
      notices.push(`${version} names ${sha7}, which is no commit in this checkout; ignored`);
    } else if (placed.placement === "descendant") {
      descendants.push({ version, sha: placed.sha });
      if (
        newest === null ||
        gitOrNo(cwd, "merge-base", "--is-ancestor", newest.sha, placed.sha) !== null
      ) {
        newest = { version, sha: placed.sha };
      }
    } else if (placed.placement === "unrelated") {
      notices.push(
        `${version} names ${sha7}, which is neither an ancestor nor a descendant of ${sourceSha.slice(0, 7)} on main; ignored`,
      );
    }
  }
  return { descendants, newest, notices };
}

/**
 * The pre-publish guard on npm state, not a decision about whether to publish (the release-PR refresh that runs the
 * publish job made that): every published pre-release is placed by its source's ancestry, so a rerun of a run that
 * already published, or a stale retry once a newer commit's pre-release is on the registry, publishes nothing,
 * whatever order the runs finished in (`npm publish --tag next` moves next to whatever it publishes). A source the
 * checkout cannot place is set aside with a notice. Null is a package the registry has never seen: the first publish goes.
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
  // A dist-tag names a version the registry holds, so next naming this one is the same rerun as the record listing it.
  if (version in packument.versions || packument["dist-tags"].next === version) {
    return {
      publish: false,
      version,
      reason: `${version} is already on the registry`,
      notices: [],
    };
  }
  const { newest, notices } = placePublished(cwd, sourceSha, packument);
  if (newest !== null) {
    return {
      publish: false,
      version,
      reason: `the registry already holds ${newest.version}, whose source ${newest.sha.slice(0, 7)} is a descendant of ${sourceSha.slice(0, 7)} on main, so this stale run publishes nothing (npm publish --tag next would move next back)`,
      notices,
    };
  }
  return { publish: true, version, notices };
}

/**
 * Only `latest` is consulted: a plain `npm publish` moves latest and leaves
 * next alone. A release sorts above the pre-releases published before its
 * merge; the next release PR's first refresh publishes the one above it.
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
  // Until the first stable release, latest names whatever the first publish was (the 0.0.0 placeholder, or a
  // pre-release): a packument always carries that key (npm/registry REGISTRY-API.md, "dist-tags: an object with at
  // least one key, latest"), whatever --tag asked for. A release must take latest over, so only a newer RELEASE holds one back.
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
 * authenticates `npm publish` alone, not `npm dist-tag add` (npm/cli#8547); the next release-PR refresh publishes and
 * moves next forward, and a rerun of the reporting run publishes nothing and passes.
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
      const { descendants, newest } = placePublished(cwd, sourceSha, packument);
      const next = packument["dist-tags"].next;
      if (newest !== null && !descendants.some((descendant) => descendant.version === next)) {
        return {
          outcome: "behind",
          version,
          reason:
            `the registry's next is ${next ?? "unset"} while it holds ${newest.version}, whose source ${newest.sha.slice(0, 7)} ` +
            `is a descendant of ${sourceSha.slice(0, 7)} on main; this stale run moved next back, and the next release-PR ` +
            `refresh moves it forward (npm dist-tag add ${name}@${newest.version} next repairs it by hand)`,
        };
      }
      return { outcome: "settled", version, reads: read };
    }
    if (read === attempts) {
      return {
        outcome: "unsettled",
        version,
        reason: `the registry's record still lacks ${version} after ${attempts} reads over ${Math.round(((attempts - 1) * delayMs) / 1000)} s; a run judged before it shows may move next back, and the release-PR refresh after it moves next forward`,
      };
    }
    await sleep(delayMs);
  }
}

function endedHow(result: SpawnSyncReturns<unknown>): string {
  const how = result.status === null ? `died of ${result.signal}` : `exited ${result.status}`;
  return result.error === undefined ? how : `${how} (${result.error.message})`;
}

function npm(cwd: string, env: Record<string, string>, ...args: string[]): void {
  const result = spawnSync("npm", args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} ${endedHow(result)}; see npm's output above.`);
  }
}

export type NpmPublishOptions = {
  cwd: string;
  /** The commit whose build is published; the checkout must be at it. */
  sourceSha: string;
  /** The registry's base URL, where the package's record is read. */
  registry: string;
} & (
  | { channel: "next"; confirm: Pick<NpmConfirmOptions, "attempts" | "delayMs"> }
  | { channel: "stable"; tag: string }
);

export type NpmPublishResult =
  | { published: false; version: string; reason: string }
  | { published: true; channel: "stable"; version: string }
  | { published: true; channel: "next"; version: string; confirmed: ConfirmVerdict };

/**
 * The publish step as one call: the channel's verdict, the publish it allows, and for next the confirmation that
 * holds the lane until the record shows the version. The verdict's notices reach `notice` before npm runs, so a
 * publish that fails still leaves them on the log. scripts.prepare is dropped from the published manifest: it
 * installs lefthook, a devDependency the tarball does not carry, and npm blocks install scripts from a
 * provenance-attested package anyway. GITHUB_SHA on the publish is the commit npm's provenance names.
 */
export async function npmPublish(
  options: NpmPublishOptions,
  notice: (line: string) => void,
): Promise<NpmPublishResult> {
  const { cwd, sourceSha, registry } = options;
  const verdict = await npmVerdict(options);
  for (const line of "notices" in verdict ? verdict.notices : []) {
    notice(line);
  }
  if (!verdict.publish) {
    return { published: false, version: verdict.version, reason: verdict.reason };
  }
  const { version } = verdict;
  if (options.channel === "stable") {
    npm(cwd, {}, "pkg", "delete", "scripts.prepare");
    npm(cwd, { GITHUB_SHA: sourceSha }, "publish");
    return { published: true, channel: "stable", version };
  }
  npm(cwd, {}, "version", version, "--no-git-tag-version");
  npm(cwd, {}, "pkg", "delete", "scripts.prepare");
  npm(cwd, { GITHUB_SHA: sourceSha }, "publish", "--tag", "next");
  const confirmed = await npmConfirm({ cwd, sourceSha, registry, ...options.confirm });
  return { published: true, channel: "next", version, confirmed };
}

/** Trusted publishing (and its provenance) exists from npm 11.5.1 on. */
export const NPM_FLOOR = "11.5.1";

/** Bun's own semver, so a two-digit minor orders numerically and a prerelease of the floor sits below it; a
 * string that is no version at all (nothing npm --version prints) counts as below it and reaches the refusal. */
function belowFloor(version: string, floor: string): boolean {
  return !Bun.semver.satisfies(version, `>=${floor}`);
}

/** An npm at or above `floor` on PATH: an older bundled npm is upgraded once (`npm install -g npm@latest`, on the
 * step's log), then held to the floor; `atFloor` false is the version still below it after that. */
export function npmFloor(floor = NPM_FLOOR): { version: string; atFloor: boolean } {
  const read = (): string =>
    execFileSync("npm", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  let version = read();
  if (belowFloor(version, floor)) {
    const install = spawnSync("npm", ["install", "-g", "npm@latest"], { stdio: "inherit" });
    if (install.status !== 0) {
      throw new Error(
        `npm ${version} is below ${floor} and npm install -g npm@latest ${endedHow(install)}; the publish needs npm ${floor} or newer.`,
      );
    }
    version = read();
  }
  return { version, atFloor: !belowFloor(version, floor) };
}
