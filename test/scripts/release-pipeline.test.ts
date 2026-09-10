/**
 * The single-tag release pipeline proven against local fixture repositories:
 * a bare "origin" plus clones playing the CI checkouts, so "the next release
 * puts vX.Y.Z and the major on a packaged child of the merge commit" is a
 * unit test, not something the first real release discovers. Covers the
 * packaged-commit topology (parent, tree, bundle bytes, the
 * carries-a-bundle invariant), idempotent reruns that verify instead of
 * move, the tamper stops, the major move, the boundary anchor, and the
 * moving latest branch (a fast-forward chain of packaged green commits).
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  advanceLatest,
  anchorCheck,
  anchorReleasePr,
  boundaryCheck,
  packageRelease,
  retagMajor,
  verifyPublishedRefs,
} from "../../.github/scripts/release-pipeline.js";

// Nearly every test here shells out to git dozens of times; bun's 5s default
// times out under parallel machine load (setDefaultTimeout is file-scoped).
setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A clone configured hermetically: fixed identity, no signing, no hooks
 * (the developer's global gitconfig must not leak into the fixtures). */
function clone(root: string, originDir: string, name: string): string {
  const dir = join(root, name);
  execFileSync("git", ["clone", "--quiet", originDir, dir]);
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgSign", "false");
  git(dir, "config", "core.hooksPath", join(root, "no-hooks"));
  return dir;
}

function write(cwd: string, file: string, content: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), content);
}

function commitAll(cwd: string, subject: string): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
}

const CHANGELOG_21 = `# Changelog

## [2.1.0](https://example.invalid/compare/v2.0.0...v2.1.0) (2026-08-14)

### Features

* single-tag scheme ([abc1234](https://example.invalid/commit/abc1234))

## [2.0.0](https://example.invalid/compare/v1.0.1...v2.0.0) (2026-08-11)

### Bug Fixes

* older fix ([def5678](https://example.invalid/commit/def5678))

## 1.0.0 (2026-07-22)

### Features

* first release ([0123abc](https://example.invalid/commit/0123abc))
`;

interface Fixture {
  root: string;
  origin: string;
  work: string;
  seedSha: string;
  mergeSha: string;
}

/** origin/main at "2.0.0 released" (seed) plus the squash-merged release PR
 * for 2.1.0 on top, with the bundle freshly "built" in the work clone -
 * exactly the state the packaging job sees. */
function seedFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "release-pipeline-"));
  roots.push(root);
  mkdirSync(join(root, "no-hooks"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  const work = clone(root, origin, "work");
  write(work, ".gitignore", "lib/index.js\n");
  write(work, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.0.0" }, null, 2)}\n`);
  write(
    work,
    "release-please-config.json",
    `${JSON.stringify(
      {
        "last-release-sha": "0000000000000000000000000000000000000000",
        packages: { ".": { "release-type": "simple", draft: true } },
      },
      null,
      2,
    )}\n`,
  );
  write(work, "CHANGELOG.md", CHANGELOG_21.replace(/## \[2\.1\.0\][\s\S]*?\n\n## /, "## "));
  write(work, "src/marker.ts", "export const marker = 1;\n");
  const seedSha = commitAll(work, "chore: seed the fixture at the 2.0.0 release");
  write(work, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.1.0" }, null, 2)}\n`);
  write(work, "CHANGELOG.md", CHANGELOG_21);
  const mergeSha = commitAll(work, "chore(main): release 2.1.0 (#42)");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  write(work, "lib/index.js", "packaged-bundle-bytes-1\n");
  return { root, origin, work, seedSha, mergeSha };
}

describe("packageRelease", () => {
  test("a fresh release tags a packaged child of the merge commit, once", () => {
    const fx = seedFixture();
    const result = packageRelease({
      cwd: fx.work,
      tag: "v2.1.0",
      sourceSha: fx.mergeSha,
      runUrl: "https://example.invalid/actions/runs/1",
    });
    expect(result.created).toBe(true);
    const packaged = git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}");
    expect(packaged).toBe(result.packagedSha);
    expect(git(fx.origin, "rev-parse", `${packaged}^`)).toBe(fx.mergeSha);
    expect(git(fx.origin, "show", `${packaged}:lib/index.js`)).toBe("packaged-bundle-bytes-1");
    const body = git(fx.origin, "log", "-1", "--format=%B", packaged);
    expect(body).toContain("build: package v2.1.0");
    expect(body).toContain(`source: ${fx.mergeSha}`);
    expect(body).toContain("workflow run: https://example.invalid/actions/runs/1");

    // Idempotent rerun: a fresh checkout that rebuilt the same bytes
    // verifies the existing tag instead of recreating or moving it.
    const rerun = clone(fx.root, fx.origin, "rerun");
    git(rerun, "checkout", "--quiet", fx.mergeSha);
    write(rerun, "lib/index.js", "packaged-bundle-bytes-1\n");
    const verified = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(verified).toEqual({ created: false, packagedSha: packaged });
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(packaged);
  });

  test("a rerun whose rebuild produced different bytes stops loudly", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const before = git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}");
    const rerun = clone(fx.root, fx.origin, "rerun-drift");
    git(rerun, "checkout", "--quiet", fx.mergeSha);
    write(rerun, "lib/index.js", "DIFFERENT-bytes\n");
    expect(() => packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /not a build of/,
    );
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(before);
  });

  test("an existing tag on the wrong parent stops loudly", () => {
    const fx = seedFixture();
    // Plant v2.1.0 on a packaged child of the SEED commit, not the merge.
    const planter = clone(fx.root, fx.origin, "planter");
    git(planter, "checkout", "--quiet", fx.seedSha);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    write(planter, "lib/index.js", "planted\n");
    git(planter, "add", "-f", "lib/index.js");
    git(planter, "commit", "--quiet", "-m", "build: package v2.1.0");
    git(planter, "tag", "v2.1.0");
    git(planter, "push", "--quiet", "origin", "refs/tags/v2.1.0");
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /its parent is/,
    );
  });

  test("an existing tag that changes more than the bundle stops loudly", () => {
    const fx = seedFixture();
    const planter = clone(fx.root, fx.origin, "planter-extra");
    git(planter, "checkout", "--quiet", fx.mergeSha);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    write(planter, "lib/index.js", "packaged-bundle-bytes-1\n");
    write(planter, "src/marker.ts", "export const marker = 666;\n");
    git(planter, "add", "-f", "lib/index.js", "src/marker.ts");
    git(planter, "commit", "--quiet", "-m", "build: package v2.1.0");
    git(planter, "tag", "v2.1.0");
    git(planter, "push", "--quiet", "origin", "refs/tags/v2.1.0");
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /is not .* plus lib\/index\.js alone/,
    );
  });

  test("a checkout that is not the merge commit refuses to package", () => {
    const fx = seedFixture();
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.seedSha })).toThrow(
      /not the source commit .* to package/,
    );
  });

  test("a well-shaped tag for a version this source did not release mints nothing", () => {
    const fx = seedFixture();
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.2.0", sourceSha: fx.mergeSha })).toThrow(
      /did not release/,
    );
    expect(git(fx.work, "ls-remote", "origin", "refs/tags/v2.2.0")).toBe("");
  });

  test("a missing bundle refuses to package", () => {
    const fx = seedFixture();
    rmSync(join(fx.work, "lib/index.js"));
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /not built/,
    );
  });

  test("a worktree dirty beyond the bundle refuses to package", () => {
    const fx = seedFixture();
    write(fx.work, "src/marker.ts", "export const marker = 999;\n");
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /pending changes beyond lib\/index\.js/,
    );
    expect(git(fx.work, "ls-remote", "origin", "refs/tags/v2.1.0")).toBe("");
  });
});

/** The next release's merge landed on origin/main, prepared from a fresh
 * clone (as CI sees it - the previous release's packaged commit lives only
 * behind its tag, never in a working branch). */
function prepareNextRelease(
  fx: Fixture,
  version: string,
  prNumber: number,
  bundle: string,
): { dir: string; mergeSha: string } {
  const dir = clone(fx.root, fx.origin, `next-${version}`);
  write(dir, ".release-please-manifest.json", `${JSON.stringify({ ".": version }, null, 2)}\n`);
  const mergeSha = commitAll(dir, `chore(main): release ${version} (#${prNumber})`);
  git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  write(dir, "lib/index.js", bundle);
  return { dir, mergeSha };
}

describe("retagMajor", () => {
  test("the major moves to the verified packaged commit", () => {
    const fx = seedFixture();
    const { packagedSha } = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const moved = retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(moved).toEqual({ major: "v2", packagedSha });
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(packagedSha);

    // The next release in the line force-moves it again.
    const next = prepareNextRelease(fx, "2.1.1", 44, "packaged-bundle-bytes-2\n");
    const packaged = packageRelease({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    retagMajor({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(packaged.packagedSha);
  });

  test("the major never moves to a package of the wrong source", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(() => retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.seedSha })).toThrow(
      /not this release's merge commit/,
    );
    expect(git(fx.origin, "ls-remote", fx.origin, "refs/tags/v2")).toBe("");
  });

  test("the major never moves to a commit that is not a pure package", () => {
    const fx = seedFixture();
    // Plant v2.1.0 as a bundle-less child of the merge commit.
    const planter = clone(fx.root, fx.origin, "planter-empty");
    git(planter, "checkout", "--quiet", fx.mergeSha);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    git(planter, "commit", "--quiet", "--allow-empty", "-m", "build: package v2.1.0");
    git(planter, "tag", "v2.1.0");
    git(planter, "push", "--quiet", "origin", "refs/tags/v2.1.0");
    const mover = clone(fx.root, fx.origin, "mover-empty");
    expect(() => retagMajor({ cwd: mover, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /does not carry a non-empty regular-file lib\/index\.js/,
    );
  });

  test("the major never moves to a package whose bundle is not this source's build", () => {
    const fx = seedFixture();
    // Plant v2.1.0 as a well-shaped packaged child (parent and tree pass)
    // carrying the WRONG bundle bytes; only the byte verification catches it.
    const planter = clone(fx.root, fx.origin, "planter-wrong-bytes");
    git(planter, "checkout", "--quiet", fx.mergeSha);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    write(planter, "lib/index.js", "planted-wrong-bytes\n");
    git(planter, "add", "-f", "lib/index.js");
    git(planter, "commit", "--quiet", "-m", "build: package v2.1.0");
    git(planter, "tag", "v2.1.0");
    git(planter, "push", "--quiet", "origin", "refs/tags/v2.1.0");
    const mover = clone(fx.root, fx.origin, "mover-wrong-bytes");
    git(mover, "checkout", "--quiet", fx.mergeSha);
    write(mover, "lib/index.js", "packaged-bundle-bytes-1\n");
    expect(() => retagMajor({ cwd: mover, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /not a build of/,
    );
    expect(git(fx.origin, "ls-remote", fx.origin, "refs/tags/v2")).toBe("");
  });

  test("a rerun of an old release's job never moves the major backward", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const next = prepareNextRelease(fx, "2.1.1", 44, "packaged-bundle-bytes-2\n");
    const packaged = packageRelease({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    retagMajor({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    // The stale rerun replays the v2.1.0 job on its old merge commit.
    const stale = clone(fx.root, fx.origin, "stale-rerun");
    git(stale, "checkout", "--quiet", fx.mergeSha);
    write(stale, "lib/index.js", "packaged-bundle-bytes-1\n");
    packageRelease({ cwd: stale, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(() => retagMajor({ cwd: stale, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /refusing to move v2 back/,
    );
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(packaged.packagedSha);
  });
});

describe("verifyPublishedRefs", () => {
  test("the version tag and the major point at the same packaged, bundle-carrying commit", () => {
    const fx = seedFixture();
    const { packagedSha } = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const checker = clone(fx.root, fx.origin, "verify-fresh");
    const verified = verifyPublishedRefs({ cwd: checker, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(verified).toEqual({ major: "v2", packagedSha });
  });

  test("a major left on a different commit fails the confirmation", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    // The major was never moved (or was moved elsewhere): point it at the
    // seed commit by hand.
    git(fx.work, "tag", "-f", "v2", fx.seedSha);
    git(fx.work, "push", "--quiet", "--force", "origin", "refs/tags/v2");
    const checker = clone(fx.root, fx.origin, "verify-drift");
    expect(() =>
      verifyPublishedRefs({ cwd: checker, tag: "v2.1.0", sourceSha: fx.mergeSha }),
    ).toThrow(/not this release's packaged commit/);
  });

  test("a missing major fails the confirmation", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const checker = clone(fx.root, fx.origin, "verify-missing");
    // The confirmation fetches refs/tags/v2 from origin; with no major ever
    // pushed, git itself refuses the fetch.
    expect(() =>
      verifyPublishedRefs({ cwd: checker, tag: "v2.1.0", sourceSha: fx.mergeSha }),
    ).toThrow(/couldn't find remote ref/);
  });

  test("a version tag on the wrong parent fails the confirmation", () => {
    const fx = seedFixture();
    const planter = clone(fx.root, fx.origin, "verify-planter");
    git(planter, "checkout", "--quiet", fx.seedSha);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    write(planter, "lib/index.js", "planted\n");
    git(planter, "add", "-f", "lib/index.js");
    git(planter, "commit", "--quiet", "-m", "build: package v2.1.0");
    git(planter, "tag", "v2.1.0");
    git(planter, "tag", "v2");
    git(planter, "push", "--quiet", "origin", "refs/tags/v2.1.0", "refs/tags/v2");
    const checker = clone(fx.root, fx.origin, "verify-wrong-parent");
    expect(() =>
      verifyPublishedRefs({ cwd: checker, tag: "v2.1.0", sourceSha: fx.mergeSha }),
    ).toThrow(/whose parent is/);
  });
});

/** Simulate release-please's PR branch: manifest + changelog bumped for the
 * next version, force-pushed from the given main head. */
function createReleasePrBranch(fx: Fixture, from: string, version: string): string {
  const dir = clone(fx.root, fx.origin, `rp-branch-${version}-${from.slice(0, 7)}`);
  git(dir, "checkout", "--quiet", "-B", "release-please--branches--main", from);
  write(dir, ".release-please-manifest.json", `${JSON.stringify({ ".": version }, null, 2)}\n`);
  write(
    dir,
    "CHANGELOG.md",
    `# Changelog\n\n## [${version}](https://example.invalid/compare) (2026-08-14)\n\n### Bug Fixes\n\n* the fix ([abc1234](https://example.invalid/commit/abc1234))\n${CHANGELOG_21}`,
  );
  commitAll(dir, `chore(main): release ${version}`);
  git(
    dir,
    "push",
    "--quiet",
    "--force",
    "origin",
    "HEAD:refs/heads/release-please--branches--main",
  );
  return dir;
}

describe("anchorReleasePr", () => {
  test("the boundary lands inside the release PR branch and merges onto main", () => {
    const fx = seedFixture();
    const mainHead = fx.mergeSha;
    createReleasePrBranch(fx, mainHead, "2.2.0");
    const worker = clone(fx.root, fx.origin, "anchor-worker");
    const result = anchorReleasePr({ cwd: worker, sourceSha: mainHead });
    expect(result.changed).toBe(true);
    // The branch now records main's head as the boundary; its release
    // content is untouched.
    const check = clone(fx.root, fx.origin, "anchor-check");
    git(check, "checkout", "--quiet", "release-please--branches--main");
    const config = JSON.parse(readFileSync(join(check, "release-please-config.json"), "utf8")) as {
      "last-release-sha": string;
    };
    expect(config["last-release-sha"]).toBe(mainHead);
    expect(readFileSync(join(check, ".release-please-manifest.json"), "utf8")).toContain("2.2.0");
    // Rerun is a no-op.
    const again = anchorReleasePr({
      cwd: clone(fx.root, fx.origin, "anchor-again"),
      sourceSha: mainHead,
    });
    expect(again.changed).toBe(false);
    // Squash-merging the PR lands the boundary on main, where the check
    // accepts it as the parent of the new release merge.
    git(check, "checkout", "--quiet", "main");
    git(check, "merge", "--quiet", "--squash", "release-please--branches--main");
    git(check, "commit", "--quiet", "-m", "chore(main): release 2.2.0 (#60)");
    git(check, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    expect(boundaryCheck(check).boundary).toBe(mainHead);
  });

  test("no release PR branch is a no-op", () => {
    const fx = seedFixture();
    const worker = clone(fx.root, fx.origin, "anchor-nobranch");
    const result = anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha });
    expect(result).toEqual({ changed: false, reason: "no release PR branch to anchor" });
  });

  test("a moved main makes the anchor defer to the newer run", () => {
    const fx = seedFixture();
    createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
    const mover = clone(fx.root, fx.origin, "anchor-mover");
    write(mover, "src/marker.ts", "export const marker = 9;\n");
    commitAll(mover, "fix: land after the anchor run started");
    git(mover, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const worker = clone(fx.root, fx.origin, "anchor-late");
    const result = anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha });
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("the newer run anchors");
  });

  test("a branch built on an older head is left for its own refresh to anchor", () => {
    const fx = seedFixture();
    // The branch was refreshed from the SEED commit; main has since moved
    // to the 2.1.0 merge. Anchoring mergeSha onto it would record a
    // boundary the branch's content was not computed from.
    createReleasePrBranch(fx, fx.seedSha, "2.2.0");
    const worker = clone(fx.root, fx.origin, "anchor-stale-branch");
    const result = anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha });
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("not built on this head");
  });

  test("a release-please refresh between anchors re-anchors from the same checkout", () => {
    const fx = seedFixture();
    createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
    const worker = clone(fx.root, fx.origin, "anchor-twice");
    expect(anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha }).changed).toBe(true);
    // The refresh force-push wipes the anchor commit; the SAME clone must
    // be able to fetch the rewritten branch and anchor again (a local
    // checked-out branch would make git refuse the fetch).
    createReleasePrBranch(fx, fx.mergeSha, "2.3.0");
    expect(anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha }).changed).toBe(true);
    const check = clone(fx.root, fx.origin, "anchor-twice-check");
    git(check, "checkout", "--quiet", "release-please--branches--main");
    const config = JSON.parse(readFileSync(join(check, "release-please-config.json"), "utf8")) as {
      "last-release-sha": string;
    };
    expect(config["last-release-sha"]).toBe(fx.mergeSha);
  });
});

describe("boundaryCheck", () => {
  test("a boundary equal to the newest release merge passes", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "boundary-eq");
    write(
      dir,
      "release-please-config.json",
      `${JSON.stringify(
        {
          "last-release-sha": fx.mergeSha,
          packages: { ".": { "release-type": "simple", draft: true } },
        },
        null,
        2,
      )}\n`,
    );
    commitAll(dir, "chore: align the fixture boundary");
    expect(boundaryCheck(dir).boundary).toBe(fx.mergeSha);
  });

  test("a stale boundary fails loudly with the repair value", () => {
    const fx = seedFixture();
    // The seed fixture's config records a placeholder, not the 2.1.0 merge.
    expect(() => boundaryCheck(fx.work)).toThrow(/stale boundary|set last-release-sha/);
  });

  test("a history without release merges and no recorded boundary is pre-first-release", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "boundary-none");
    git(dir, "checkout", "--quiet", fx.seedSha);
    write(
      dir,
      "release-please-config.json",
      `${JSON.stringify({ packages: { ".": { "release-type": "simple", draft: true } } }, null, 2)}\n`,
    );
    commitAll(dir, "chore: bootstrap release-please before any release");
    expect(boundaryCheck(dir).boundary).toContain("no release merge");
  });

  test("a recorded boundary that is not on this history fails naming that", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "boundary-foreign");
    // The seed commit records a placeholder boundary and has no release
    // merge behind it.
    git(dir, "checkout", "--quiet", fx.seedSha);
    expect(() => boundaryCheck(dir)).toThrow(/not on this history at all/);
  });

  test("a shallow checkout is refused before any verdict", () => {
    const fx = seedFixture();
    // The release merge is within depth but its parent, the recorded
    // boundary, is not: a full history passes this, a truncated one would
    // call it stale.
    write(
      fx.work,
      "release-please-config.json",
      `${JSON.stringify(
        {
          "last-release-sha": fx.seedSha,
          packages: { ".": { "release-type": "simple", draft: true } },
        },
        null,
        2,
      )}\n`,
    );
    commitAll(fx.work, "chore: align the fixture boundary");
    git(fx.work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const dir = join(fx.root, "boundary-shallow");
    execFileSync("git", ["clone", "--quiet", "--depth", "2", `file://${fx.origin}`, dir]);
    expect(() => boundaryCheck(dir)).toThrow(/needs the full history.*shallow/);
  });

  test("a complete history holding the boundary but no recognizable merge names the matcher", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "boundary-drift");
    git(dir, "checkout", "--quiet", fx.seedSha);
    write(
      dir,
      "release-please-config.json",
      `${JSON.stringify(
        {
          "last-release-sha": fx.seedSha,
          packages: { ".": { "release-type": "simple", draft: true } },
        },
        null,
        2,
      )}\n`,
    );
    commitAll(dir, "chore(main): release: 2.1.0 (#42)");
    expect(() => boundaryCheck(dir)).toThrow(/history holds it.*RELEASE_SUBJECT/);
  });

  test("a boundary newer than the newest recognized merge is drift, not a rollback", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "boundary-newer");
    write(dir, "src/marker.ts", "export const marker = 3;\n");
    const between = commitAll(dir, "feat: land between two releases");
    // The 2.2.0 release PR anchored main's tip and merged under a subject
    // RELEASE_SUBJECT does not match: the 2.1.0 merge is still the newest
    // one recognized, yet the boundary sits after it.
    write(dir, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.2.0" }, null, 2)}\n`);
    write(
      dir,
      "release-please-config.json",
      `${JSON.stringify(
        {
          "last-release-sha": between,
          packages: { ".": { "release-type": "simple", draft: true } },
        },
        null,
        2,
      )}\n`,
    );
    commitAll(dir, "chore(main): release v2.2.0 (#43)");
    expect(() => boundaryCheck(dir)).toThrow(/NEWER than.*must not be rolled back/);
  });

  test("a boundary on an unmerged branch is stale, not newer", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "boundary-off-main");
    // A descendant of the release merge that never landed on main: the
    // stale message's rollback IS the repair here.
    git(dir, "checkout", "--quiet", "-b", "side");
    write(dir, "src/marker.ts", "export const marker = 4;\n");
    const offMain = commitAll(dir, "feat: never merged");
    git(dir, "checkout", "--quiet", "main");
    write(
      dir,
      "release-please-config.json",
      `${JSON.stringify(
        {
          "last-release-sha": offMain,
          packages: { ".": { "release-type": "simple", draft: true } },
        },
        null,
        2,
      )}\n`,
    );
    commitAll(dir, "chore: record a boundary from the wrong branch");
    expect(() => boundaryCheck(dir)).toThrow(/stale boundary.*set last-release-sha/);
  });

  test("a subject that only shares the release prefix is not a release merge", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "boundary-decoy");
    write(
      dir,
      "release-please-config.json",
      `${JSON.stringify(
        {
          "last-release-sha": fx.mergeSha,
          packages: { ".": { "release-type": "simple", draft: true } },
        },
        null,
        2,
      )}\n`,
    );
    commitAll(dir, "chore: align the fixture boundary");
    // Newer than the release merge, matching its prefix but not its shape:
    // must neither become the boundary nor park the check.
    write(dir, "src/marker.ts", "export const marker = 7;\n");
    commitAll(dir, "chore(main): release pipeline documentation");
    expect(boundaryCheck(dir).boundary).toBe(fx.mergeSha);
  });
});

describe("anchorCheck", () => {
  test("a release PR whose anchor is missing is unmergeable", () => {
    const fx = seedFixture();
    createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
    const pr = clone(fx.root, fx.origin, "anchor-check-missing");
    git(pr, "checkout", "--quiet", "release-please--branches--main");
    expect(() => anchorCheck(pr)).toThrow(/anchor is missing or stale/);
  });

  test("an anchored release PR passes", () => {
    const fx = seedFixture();
    createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
    const worker = clone(fx.root, fx.origin, "anchor-check-worker");
    expect(anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha }).changed).toBe(true);
    const pr = clone(fx.root, fx.origin, "anchor-check-ok");
    git(pr, "checkout", "--quiet", "release-please--branches--main");
    expect(anchorCheck(pr).boundary).toBe(fx.mergeSha);
  });
});

describe("advanceLatest", () => {
  /** A later green push to main, prepared as CI sees it: a fresh clone at
   * the new head with the bundle "built" from it. */
  function pushGreenCommit(
    fx: Fixture,
    name: string,
    bundle: string,
  ): { dir: string; sha: string } {
    const dir = clone(fx.root, fx.origin, name);
    write(dir, "src/marker.ts", `export const marker = "${name}";\n`);
    const sha = commitAll(dir, `feat: ${name}`);
    git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    write(dir, "lib/index.js", bundle);
    return { dir, sha };
  }

  /** The Source trailer as git parses it: proves the value sits in a real
   * trailer block, not just somewhere in the body. */
  function sourceTrailer(cwd: string, sha: string): string {
    return git(cwd, "log", "-1", "--format=%(trailers:key=Source,valueonly)", sha);
  }

  test("the first advance creates latest as a packaged child of the green commit, and a rerun verifies it", () => {
    const fx = seedFixture();
    const result = advanceLatest({
      cwd: fx.work,
      sourceSha: fx.mergeSha,
      runUrl: "https://example.invalid/actions/runs/7",
    });
    expect(result.changed).toBe(true);
    const tip = git(fx.origin, "rev-parse", "refs/heads/latest");
    expect(tip).toBe(result.latestSha);
    expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(fx.mergeSha);
    expect(git(fx.origin, "diff", "--name-only", fx.mergeSha, tip)).toBe("lib/index.js");
    expect(git(fx.origin, "show", `${tip}:lib/index.js`)).toBe("packaged-bundle-bytes-1");
    const body = git(fx.origin, "log", "-1", "--format=%B", tip);
    expect(body).toContain(
      `build(latest): main at ${git(fx.origin, "rev-parse", "--short", fx.mergeSha)}`,
    );
    expect(body).toContain("Workflow-run: https://example.invalid/actions/runs/7");
    expect(sourceTrailer(fx.origin, tip)).toBe(fx.mergeSha);
    // The checkout itself is untouched: HEAD still the source, index clean.
    expect(git(fx.work, "rev-parse", "HEAD")).toBe(fx.mergeSha);
    expect(git(fx.work, "status", "--porcelain")).toBe("");

    // Idempotent rerun from a fresh checkout that rebuilt the bundle.
    const rerun = clone(fx.root, fx.origin, "latest-rerun");
    git(rerun, "checkout", "--quiet", fx.mergeSha);
    write(rerun, "lib/index.js", "packaged-bundle-bytes-1\n");
    const again = advanceLatest({ cwd: rerun, sourceSha: fx.mergeSha });
    expect(again).toEqual({
      changed: false,
      latestSha: tip,
      reason: `refs/heads/latest already packages ${fx.mergeSha} at ${tip}`,
    });
    expect(git(fx.origin, "rev-parse", "refs/heads/latest")).toBe(tip);
  });

  test("a newer green commit appends a fast-forward child of the previous tip", () => {
    const fx = seedFixture();
    const first = advanceLatest({ cwd: fx.work, sourceSha: fx.mergeSha }).latestSha;
    // The stale rerun's checkout is cloned BEFORE the newer commit exists:
    // it must learn that commit from origin to see latest as already past.
    const stale = clone(fx.root, fx.origin, "latest-stale");
    git(stale, "checkout", "--quiet", fx.mergeSha);
    write(stale, "lib/index.js", "packaged-bundle-bytes-1\n");
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const second = advanceLatest({ cwd: next.dir, sourceSha: next.sha });
    expect(second.changed).toBe(true);
    const tip = git(fx.origin, "rev-parse", "refs/heads/latest");
    expect(tip).toBe(second.latestSha);
    expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(first);
    expect(git(fx.origin, "diff", "--name-only", next.sha, tip)).toBe("lib/index.js");
    expect(git(fx.origin, "show", `${tip}:lib/index.js`)).toBe("packaged-bundle-bytes-2");
    expect(git(fx.origin, "show", `${tip}:src/marker.ts`)).toBe(
      'export const marker = "second-green";',
    );
    expect(sourceTrailer(fx.origin, tip)).toBe(next.sha);

    // The stale rerun of the older commit's run finds latest already past it.
    expect(advanceLatest({ cwd: stale, sourceSha: fx.mergeSha })).toEqual({
      changed: false,
      latestSha: tip,
      reason: `refs/heads/latest is already past ${fx.mergeSha} (built from ${next.sha}); the newer run advanced it`,
    });
    expect(git(fx.origin, "rev-parse", "refs/heads/latest")).toBe(tip);
  });

  /** A hand-pushed refs/heads/latest: a child of `from` under `message`
   * carrying `files` (by default just a bundle that is not CI's build; a
   * `{ linkTo }` value plants a symlink), force-pushed over whatever latest held. */
  function plantLatest(
    fx: Fixture,
    name: string,
    from: string,
    message: string[],
    files: Record<string, string | { linkTo: string }> = { "lib/index.js": "planted\n" },
  ): string {
    const planter = clone(fx.root, fx.origin, name);
    git(planter, "checkout", "--quiet", from);
    for (const [file, content] of Object.entries(files)) {
      if (typeof content === "string") {
        write(planter, file, content);
      } else {
        mkdirSync(dirname(join(planter, file)), { recursive: true });
        symlinkSync(content.linkTo, join(planter, file));
      }
      git(planter, "add", "-f", file);
    }
    const paragraphs = message.flatMap((paragraph) => ["-m", paragraph]);
    git(planter, "commit", "--quiet", "--allow-empty", ...paragraphs);
    git(planter, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/latest");
    return git(planter, "rev-parse", "HEAD");
  }

  /** A side branch off `from` that never reached main, pushed to origin; a
   * latest tip built from it names a source off main's history. */
  function plantForeignLatest(fx: Fixture, from: string): { sideSha: string; planted: string } {
    const side = clone(fx.root, fx.origin, "latest-side");
    git(side, "checkout", "--quiet", "-b", "side", from);
    write(side, "src/marker.ts", "export const marker = 'side';\n");
    const sideSha = commitAll(side, "feat: never merged");
    git(side, "push", "--quiet", "origin", "HEAD:refs/heads/side");
    const planted = plantLatest(fx, "latest-foreign", sideSha, [
      "build(latest): by hand",
      `Source: ${sideSha}`,
    ]);
    return { sideSha, planted };
  }

  const byHand = "refusing to build on a latest this pipeline did not mint - inspect it by hand.";

  /** The tree `source` plus the planted bundle would have: what a tip that
   * names `source` is held against. */
  function rebuiltTree(fx: Fixture, name: string, source: string): string {
    const rebuild = clone(fx.root, fx.origin, name);
    git(rebuild, "checkout", "--quiet", source);
    write(rebuild, "lib/index.js", "planted\n");
    git(rebuild, "add", "-f", "lib/index.js");
    return git(rebuild, "write-tree");
  }

  /** The exact refusal for a tip whose tree is not its Source plus the bundle. */
  function notAPackage(fx: Fixture, planted: string, source: string, changed: string): Error {
    const actual = git(fx.origin, "rev-parse", `${planted}^{tree}`);
    const expected = rebuiltTree(fx, `rebuilt-${planted.slice(0, 8)}`, source);
    return new Error(
      `refs/heads/latest is at ${planted}, which names ${source} as its source but is not ${source} plus lib/index.js alone: its tree is ${actual}, the rebuilt one is ${expected} (paths beyond the bundle changed relative to ${source}: ${changed}); ${byHand}`,
    );
  }

  /** A tip crafted with plumbing: `from`'s tree plus the planted bundle plus
   * an EMPTY subtree at `empty/`, which a path diff cannot list. */
  function plantEmptySubtreeLatest(fx: Fixture, from: string): string {
    const planter = clone(fx.root, fx.origin, "latest-empty-subtree");
    git(planter, "checkout", "--quiet", from);
    write(planter, "lib/index.js", "planted\n");
    git(planter, "add", "-f", "lib/index.js");
    const emptyTree = execFileSync("git", ["hash-object", "-w", "-t", "tree", "--stdin"], {
      cwd: planter,
      input: "",
      encoding: "utf8",
    }).trim();
    const entries = `${git(planter, "ls-tree", git(planter, "write-tree"))}\n040000 tree ${emptyTree}\tempty\n`;
    const tree = execFileSync("git", ["mktree"], {
      cwd: planter,
      input: entries,
      encoding: "utf8",
    }).trim();
    const planted = git(
      planter,
      "commit-tree",
      tree,
      "-p",
      from,
      "-m",
      "build(latest): by hand",
      "-m",
      `Source: ${from}`,
    );
    git(planter, "push", "--quiet", "--force", "origin", `${planted}:refs/heads/latest`);
    return planted;
  }

  /** Plants a latest tip the advance from fx.work (at the merge commit) must refuse; returns the tip and the exact or matching error. */
  type Refusal = (fx: Fixture) => { planted: string; error: RegExp | Error };
  const refused: [string, Refusal][] = [
    [
      "built from a commit off main's history that this checkout knows",
      (fx) => {
        const { planted } = plantForeignLatest(fx, fx.seedSha);
        // Known locally, so the verdict is merge-base's, not the unknown-sha screen.
        git(fx.work, "fetch", "--quiet", "origin", "refs/heads/side");
        return { planted, error: /not on main's history at .*; refusing to append/ };
      },
    ],
    [
      "built from a commit this checkout has never seen",
      (fx) => ({
        planted: plantForeignLatest(fx, fx.seedSha).planted,
        error: /not on main's history at .*; refusing to append/,
      }),
    ],
    [
      "built from a descendant of this commit that never reached main",
      (fx) => {
        // Descends from main's head, so ancestry alone would read it as a
        // newer run's work; only its absence from main tells it apart.
        const { planted } = plantForeignLatest(fx, fx.mergeSha);
        git(fx.work, "fetch", "--quiet", "origin", "refs/heads/side");
        return { planted, error: /not on main's history at .*; refusing to append/ };
      },
    ],
    [
      "carrying no Source trailer",
      (fx) => ({
        planted: plantLatest(fx, "latest-untrailed", fx.mergeSha, ["build: by hand"]),
        error: /carries no Source trailer/,
      }),
    ],
    [
      "naming this source but changing more than the bundle",
      (fx) => {
        const planted = plantLatest(
          fx,
          "latest-extra",
          fx.mergeSha,
          ["build(latest): by hand", `Source: ${fx.mergeSha}`],
          { "lib/index.js": "planted\n", "src/marker.ts": "export const marker = 666;\n" },
        );
        return { planted, error: notAPackage(fx, planted, fx.mergeSha, "src/marker.ts") };
      },
    ],
    [
      "naming this source with a bundle that is not this checkout's build",
      (fx) => {
        // The tree CI's build of this source packages, taken from a genuine
        // advance; the planted tip then replaces it with another bundle.
        const genuine = clone(fx.root, fx.origin, "latest-genuine");
        write(genuine, "lib/index.js", "packaged-bundle-bytes-1\n");
        const built = advanceLatest({ cwd: genuine, sourceSha: fx.mergeSha }).latestSha;
        const tree = git(fx.origin, "rev-parse", `${built}^{tree}`);
        const planted = plantLatest(fx, "latest-rebuilt", fx.mergeSha, [
          "build(latest): by hand",
          `Source: ${fx.mergeSha}`,
        ]);
        const plantedTree = git(fx.origin, "rev-parse", `${planted}^{tree}`);
        return {
          planted,
          error: new Error(
            `refs/heads/latest is at ${planted}, which names ${fx.mergeSha} as its source but its tree ${plantedTree} is not the tree ${tree} this checkout's build of ${fx.mergeSha} packages, so the two differ in their lib/index.js entry (bytes or file mode): either the tip was not built from this source or the build is not reproducible, and the Source trailer cannot tell those apart. Diff the two trees by hand; a hand-pushed tip is left for the next green push to bury (the ruleset on latest forbids moving it back), a build that differs between runs is fixed before latest can be trusted.`,
          ),
        };
      },
    ],
    [
      "naming a newer main commit but lacking its bundle",
      (fx) => {
        // A stale rerun would read this as "already past"; the tip's own
        // tree still has to be a package of the source it names.
        const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
        const planted = plantLatest(
          fx,
          "latest-unbundled",
          next.sha,
          ["build(latest): by hand", `Source: ${next.sha}`],
          {},
        );
        return {
          planted,
          error: new Error(
            `${planted} does not carry a non-empty regular-file lib/index.js (no entry); refusing to point a consumable ref at an unpackaged commit.`,
          ),
        };
      },
    ],
    [
      "naming a newer main commit but carrying the bundle as a symlink",
      (fx) => {
        // A symlink at the bundle's path has a size (its target text), so a
        // size probe alone would bless a tip consumers cannot run.
        const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
        const planted = plantLatest(
          fx,
          "latest-symlinked",
          next.sha,
          ["build(latest): by hand", `Source: ${next.sha}`],
          { "lib/index.js": { linkTo: "../src/marker.ts" } },
        );
        const entry = git(fx.origin, "ls-tree", "-l", planted, "--", "lib/index.js").split("\t")[0];
        return {
          planted,
          error: new Error(
            `${planted} does not carry a non-empty regular-file lib/index.js (entry ${entry}); refusing to point a consumable ref at an unpackaged commit.`,
          ),
        };
      },
    ],
    [
      "naming a newer main commit and carrying an empty subtree beyond the bundle",
      (fx) => {
        // Invisible to a path diff (no path lives in an empty tree), so only
        // tree identity catches it.
        const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
        const planted = plantEmptySubtreeLatest(fx, next.sha);
        return {
          planted,
          error: notAPackage(
            fx,
            planted,
            next.sha,
            "none (an entry a path diff cannot list, such as an empty subtree)",
          ),
        };
      },
    ],
    [
      "naming an older main commit and carrying a file beyond the bundle",
      (fx) => {
        // The append path: an older source is a valid parent only when its
        // tip is a pure package, never with a foreign file riding along.
        const planted = plantLatest(
          fx,
          "latest-older-extra",
          fx.seedSha,
          ["build(latest): by hand", `Source: ${fx.seedSha}`],
          { "lib/index.js": "planted\n", "src/marker.ts": "export const marker = 666;\n" },
        );
        return { planted, error: notAPackage(fx, planted, fx.seedSha, "src/marker.ts") };
      },
    ],
  ];
  test.each(refused)("a latest tip %s stops the advance and stays put", (_name, plant) => {
    const fx = seedFixture();
    const { planted, error } = plant(fx);
    expect(() => advanceLatest({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(error);
    expect(git(fx.origin, "rev-parse", "refs/heads/latest")).toBe(planted);
  });

  test("an empty bundle never reaches latest", () => {
    const fx = seedFixture();
    write(fx.work, "lib/index.js", "");
    expect(() => advanceLatest({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(
      /does not carry a non-empty regular-file lib\/index\.js/,
    );
    expect(git(fx.work, "ls-remote", "origin", "refs/heads/latest")).toBe("");
  });

  test("a shallow checkout is refused before any verdict", () => {
    const fx = seedFixture();
    const dir = join(fx.root, "latest-shallow");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${fx.origin}`, dir]);
    write(dir, "lib/index.js", "packaged-bundle-bytes-1\n");
    expect(() => advanceLatest({ cwd: dir, sourceSha: fx.mergeSha })).toThrow(
      /needs the full history.*shallow/,
    );
    expect(git(fx.work, "ls-remote", "origin", "refs/heads/latest")).toBe("");
  });

  /** What the shim does to the pipeline's n-th push, before real git sees it. */
  type PushPlan =
    /** Push `sha` to latest first from `from`; real git then rejects the pipeline's push. */
    | { competitor: { from: string; sha: string } }
    /** Replay a remote a file:// origin cannot play: this stderr, this exit status. */
    | { fail: { stderr: string; status: number } };

  /** Run `body` with a `git` shim first on PATH: the real git for everything
   * but push, and every push appended to a log before its plan (by ordinal;
   * none lets it through) runs. Returns the push argument lists. */
  function withPushPlans(fx: Fixture, plans: PushPlan[], body: () => void): string[][] {
    const shim = join(fx.root, "git-shim");
    const plansDir = join(shim, "plans");
    mkdirSync(plansDir, { recursive: true });
    const realGit = Bun.which("git");
    if (realGit === null) {
      throw new Error("no git on PATH");
    }
    for (const [index, plan] of plans.entries()) {
      const file = join(plansDir, String(index + 1));
      if ("competitor" in plan) {
        writeFileSync(file, `competitor ${plan.competitor.from} ${plan.competitor.sha}\n`);
      } else {
        writeFileSync(file, `fail ${plan.fail.status}\n`);
        writeFileSync(`${file}.stderr`, plan.fail.stderr);
      }
    }
    const script = [
      "#!/bin/sh",
      `if [ "$1" != "push" ]; then exec "${realGit}" "$@"; fi`,
      `printf '%s\\n' "$*" >> "${shim}/pushes.log"`,
      `n=$(wc -l < "${shim}/pushes.log" | tr -d ' ')`,
      `plan="${plansDir}/$n"`,
      'if [ -f "$plan" ]; then',
      '  read -r kind a b < "$plan"',
      '  case "$kind" in',
      `    competitor) "${realGit}" -C "$a" push --quiet origin "$b:refs/heads/latest" ;;`,
      '    fail) cat "$plan.stderr" >&2; exit "$a" ;;',
      "  esac",
      "fi",
      `exec "${realGit}" "$@"`,
      "",
    ].join("\n");
    writeFileSync(join(shim, "git"), script, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
      body();
    } finally {
      process.env.PATH = path;
    }
    return readFileSync(join(shim, "pushes.log"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split(" "));
  }

  /** `count` packaged commits of the seed, chained, in a clone that has not
   * pushed them: what other runs would append to latest, as the plans that
   * land one ahead of each of this run's pushes. */
  function competitors(
    fx: Fixture,
    count: number,
  ): { from: string; plans: PushPlan[]; shas: string[]; first: string; last: string } {
    const from = clone(fx.root, fx.origin, "latest-competitor");
    git(from, "checkout", "--quiet", fx.seedSha);
    write(from, "lib/index.js", "competitor-bundle\n");
    git(from, "add", "-f", "lib/index.js");
    const shas: string[] = [];
    let first = "";
    let last = "";
    for (let n = 1; n <= count; n++) {
      git(
        from,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        `build(latest): competitor ${n}`,
        "-m",
        `Source: ${fx.seedSha}`,
      );
      last = git(from, "rev-parse", "HEAD");
      first = first === "" ? last : first;
      shas.push(last);
    }
    return { from, plans: shas.map((sha) => ({ competitor: { from, sha } })), shas, first, last };
  }

  const pushOf = (sha: string): string[] => ["push", "origin", `${sha}:refs/heads/latest`];
  /** The commit a logged push carried (its objects exist in the pushing clone). */
  const pushedSha = (push: string[]): string =>
    push.join(" ").replace(/^push origin (\w+):.*$/, "$1");

  /** The retried outcome after one overtaken push: latest landed as the
   * child of the rival's tip, and the two pushes carried a child of `before`
   * (the tip this run first observed, rejected) and then the child of the
   * rival's tip. */
  function expectRetriedOnto(
    fx: Fixture,
    before: string,
    rivalTip: string,
    result: ReturnType<typeof advanceLatest> | undefined,
    pushes: string[][],
  ): void {
    const tip = git(fx.origin, "rev-parse", "refs/heads/latest");
    expect(result).toEqual({
      changed: true,
      latestSha: tip,
      reason: `refs/heads/latest: advanced to ${tip}`,
    });
    expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(rivalTip);
    expect(sourceTrailer(fx.origin, tip)).toBe(fx.mergeSha);
    const shas = pushes.map(pushedSha);
    expect(pushes).toEqual(shas.map(pushOf));
    expect(shas.map((sha) => git(fx.work, "rev-parse", `${sha}^`))).toEqual([before, rivalTip]);
    expect(shas).toContain(tip);
  }

  test("a push overtaken by another run is retried on the new tip", () => {
    const fx = seedFixture();
    const rival = competitors(fx, 1);
    let result: ReturnType<typeof advanceLatest> | undefined;
    const pushes = withPushPlans(fx, rival.plans, () => {
      result = advanceLatest({ cwd: fx.work, sourceSha: fx.mergeSha });
    });
    expectRetriedOnto(fx, fx.mergeSha, rival.first, result, pushes);
  });

  // The rival lands DURING the pipeline's push: origin's update hook moves
  // latest once receive-pack has advertised it, so the update itself fails
  // its compare-and-set with git's own words for a ref created since
  // ("reference already exists") or moved since ("is at ... but expected").
  const raced: [string, boolean][] = [
    ["created", false],
    ["moved", true],
  ];
  test.each(raced)(
    "a push whose ref the server finds %s since advertising it is retried",
    (_name, preexisting) => {
      const fx = seedFixture();
      const rival = competitors(fx, preexisting ? 2 : 1);
      git(rival.from, "push", "--quiet", "origin", `${rival.last}:refs/heads/rival`);
      if (preexisting) {
        git(rival.from, "push", "--quiet", "origin", `${rival.first}:refs/heads/latest`);
      }
      const hooks = join(fx.origin, "hooks");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, "update"),
        `#!/bin/sh\n[ "$1" = refs/heads/latest ] || exit 0\ngit update-ref refs/heads/latest ${rival.last}\n`,
        { mode: 0o755 },
      );
      git(fx.origin, "config", "core.hooksPath", hooks);
      let result: ReturnType<typeof advanceLatest> | undefined;
      const pushes = withPushPlans(fx, [], () => {
        result = advanceLatest({ cwd: fx.work, sourceSha: fx.mergeSha });
      });
      expectRetriedOnto(fx, preexisting ? rival.first : fx.mergeSha, rival.last, result, pushes);
    },
  );

  test("GitHub's wording of that server-side compare-and-set loss is retried too", () => {
    const fx = seedFixture();
    const stderr = `To https://github.com/o/r.git\n ! [remote rejected] 0123abc -> latest (cannot lock ref 'refs/heads/latest': is at ${fx.seedSha} but expected ${fx.mergeSha})\nerror: failed to push some refs to 'https://github.com/o/r.git'\n`;
    let result: ReturnType<typeof advanceLatest> | undefined;
    // The scripted loss lands nothing, so the retry finds no latest and
    // pushes the source's own child again, this time for real.
    const pushes = withPushPlans(fx, [{ fail: { stderr, status: 1 } }], () => {
      result = advanceLatest({ cwd: fx.work, sourceSha: fx.mergeSha });
    });
    const tip = git(fx.origin, "rev-parse", "refs/heads/latest");
    expect(result).toEqual({
      changed: true,
      latestSha: tip,
      reason: `refs/heads/latest: advanced to ${tip}`,
    });
    const shas = pushes.map(pushedSha);
    expect(pushes).toEqual(shas.map(pushOf));
    expect(shas.map((sha) => git(fx.work, "rev-parse", `${sha}^`))).toEqual([
      fx.mergeSha,
      fx.mergeSha,
    ]);
    expect(shas.at(-1)).toBe(tip);
  });

  test("a push overtaken on every attempt gives up naming the concurrent mover", () => {
    const fx = seedFixture();
    const rival = competitors(fx, 3);
    const pushes = withPushPlans(fx, rival.plans, () => {
      expect(() => advanceLatest({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(
        "could not advance refs/heads/latest after 3 attempts; something keeps moving it concurrently - rerun this job once it settles.",
      );
    });
    // Each attempt re-read the tip and built on it before being overtaken again.
    const shas = pushes.map(pushedSha);
    expect(pushes).toEqual(shas.map(pushOf));
    expect(shas.map((sha) => git(fx.work, "rev-parse", `${sha}^`))).toEqual([
      fx.mergeSha,
      ...rival.shas.slice(0, -1),
    ]);
    expect(git(fx.origin, "rev-parse", "refs/heads/latest")).toBe(rival.last);
  });

  const permanent: [string, string][] = [
    [
      "a token without write access",
      "remote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403\n",
    ],
    [
      "a ruleset declining the ref",
      "remote: error: GH013: Repository rule violations found for refs/heads/latest.\nremote:\nremote: - Cannot update this protected ref.\nremote:\nTo https://github.com/o/r.git\n ! [remote rejected] 0123abc -> latest (push declined due to repository rule violations)\nerror: failed to push some refs to 'https://github.com/o/r.git'\n",
    ],
  ];
  test.each(permanent)(
    "%s fails the first push for good, with git's own words",
    (_name, stderr) => {
      const fx = seedFixture();
      let error: unknown;
      const pushes = withPushPlans(fx, [{ fail: { stderr, status: 128 } }], () => {
        try {
          advanceLatest({ cwd: fx.work, sourceSha: fx.mergeSha });
        } catch (thrown) {
          error = thrown;
        }
      });
      // One push, of the source's own packaged child, then the failure as git
      // worded it: no retry, no "moving it concurrently".
      const shas = pushes.map(pushedSha);
      expect(pushes).toEqual(shas.map(pushOf));
      expect(shas.map((sha) => git(fx.work, "rev-parse", `${sha}^`))).toEqual([fx.mergeSha]);
      expect(error).toEqual(
        new Error(`git push origin ${shas.join()}:refs/heads/latest failed: ${stderr.trim()}`),
      );
      expect(git(fx.work, "ls-remote", "origin", "refs/heads/latest")).toBe("");
    },
  );
});

describe("release configuration contract", () => {
  test("the committed config pins the tagless-draft knobs (shape only; the flow itself is not exercised here)", () => {
    const config = JSON.parse(
      readFileSync(join(import.meta.dir, "../../release-please-config.json"), "utf8"),
    ) as {
      "skip-github-release"?: unknown;
      "include-component-in-tag"?: unknown;
      "last-release-sha"?: unknown;
      packages: Record<string, Record<string, unknown>>;
    };
    const root = config.packages["."];
    // draft + force-tag-creation pinned FALSE (explicit, not the upstream
    // default, which could change) is what keeps release-please from ever
    // creating a tag on main; the hook mints the only tag, on the packaged
    // child. include-component-in-tag: false keeps tags strictly vX.Y.Z,
    // the one shape releaseMajor() accepts. skip-github-release would stop
    // releases entirely (release_created never fires, the hook never runs).
    expect(root?.draft).toBe(true);
    expect(root?.["force-tag-creation"]).toBe(false);
    expect(config["skip-github-release"]).toBeUndefined();
    expect(config["include-component-in-tag"]).toBe(false);
    expect(typeof config["last-release-sha"]).toBe("string");
  });
});

describe("release tag shape", () => {
  test("a non-vX.Y.Z tag mints nothing", () => {
    const fx = seedFixture();
    expect(() =>
      packageRelease({ cwd: fx.work, tag: "v2.1-rc.0", sourceSha: fx.mergeSha }),
    ).toThrow(/not a vX\.Y\.Z release tag/);
    expect(git(fx.work, "ls-remote", "origin", "refs/tags/v2.1-rc.0")).toBe("");
  });
});
