/**
 * The single-tag release pipeline proven against local fixture repositories:
 * a bare "origin" plus clones playing the CI checkouts, so "the next release
 * puts vX.Y.Z and the major on a packaged child of the merge commit" is a
 * unit test, not something the first real release discovers. Covers the
 * detection asserts (a hand-edited manifest can never mint a tag), the
 * packaged-commit topology (parent, tree, bundle bytes, the
 * carries-a-bundle invariant), idempotent reruns that verify instead of
 * move, the tamper stops, the major move, the boundary anchor, and the
 * changelog extraction.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  anchorBoundary,
  detectRelease,
  extractReleaseNotes,
  packageRelease,
  retagMajor,
  verifyPublishedRefs,
} from "../../.github/scripts/release-pipeline.js";

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
        "skip-github-release": true,
        "last-release-sha": "0000000000000000000000000000000000000000",
        packages: { ".": { "release-type": "simple" } },
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

describe("detectRelease", () => {
  const fx = seedFixture();

  test("a squash-merged release PR is detected with its version and tag", () => {
    expect(detectRelease(fx.work)).toEqual({ version: "2.1.0", tag: "v2.1.0" });
  });

  test("an ordinary commit is not a release", () => {
    const dir = clone(fx.root, fx.origin, "detect-ordinary");
    write(dir, "src/marker.ts", "export const marker = 2;\n");
    commitAll(dir, "fix: an ordinary change");
    expect(detectRelease(dir)).toBeNull();
  });

  test("a manifest hand edit outside a release-please merge refuses to tag", () => {
    const dir = clone(fx.root, fx.origin, "detect-hand-edit");
    write(dir, ".release-please-manifest.json", `${JSON.stringify({ ".": "9.9.9" }, null, 2)}\n`);
    commitAll(dir, "chore: tweak the manifest by hand");
    expect(() => detectRelease(dir)).toThrow(/refusing to tag/);
  });

  test("a subject/manifest version disagreement refuses to tag", () => {
    const dir = clone(fx.root, fx.origin, "detect-mismatch");
    write(dir, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.2.0" }, null, 2)}\n`);
    commitAll(dir, "chore(main): release 2.3.0 (#43)");
    expect(() => detectRelease(dir)).toThrow(/2\.3\.0.*2\.2\.0|2\.2\.0.*2\.3\.0/);
  });

  test("a manifest touch without a version step is not a release", () => {
    const dir = clone(fx.root, fx.origin, "detect-reformat");
    write(dir, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.1.0" })}\n`);
    commitAll(dir, "chore: reformat the manifest");
    expect(detectRelease(dir)).toBeNull();
  });

  test("a root commit is not a release", () => {
    const dir = join(fx.root, "detect-root");
    execFileSync("git", ["init", "--quiet", "-b", "main", dir]);
    git(dir, "config", "user.name", "fixture");
    git(dir, "config", "user.email", "fixture@example.invalid");
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "config", "core.hooksPath", join(fx.root, "no-hooks"));
    write(dir, ".release-please-manifest.json", `${JSON.stringify({ ".": "1.0.0" }, null, 2)}\n`);
    commitAll(dir, "chore(main): release 1.0.0 (#1)");
    expect(detectRelease(dir)).toBeNull();
  });
});

describe("extractReleaseNotes", () => {
  test("a linked heading's section runs to the next version heading", () => {
    const notes = extractReleaseNotes(CHANGELOG_21, "2.1.0");
    expect(notes).toContain("## [2.1.0]");
    expect(notes).toContain("single-tag scheme");
    expect(notes).not.toContain("2.0.0]");
    expect(notes).not.toContain("older fix");
  });

  test("a bare heading (the first release's format) extracts to EOF", () => {
    const notes = extractReleaseNotes(CHANGELOG_21, "1.0.0");
    expect(notes).toContain("## 1.0.0");
    expect(notes).toContain("first release");
  });

  test("a version the changelog lacks throws", () => {
    expect(() => extractReleaseNotes(CHANGELOG_21, "3.0.0")).toThrow(/no "## 3\.0\.0" section/);
  });

  test("a version is matched whole, not as a prefix of a longer version", () => {
    expect(() => extractReleaseNotes(CHANGELOG_21, "2.1")).toThrow(/no "## 2\.1" section/);
  });
});

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
      /changes more than lib\/index\.js/,
    );
  });

  test("a checkout that is not the merge commit refuses to package", () => {
    const fx = seedFixture();
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.seedSha })).toThrow(
      /not the release merge commit/,
    );
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
      /wrong source/,
    );
    expect(git(fx.origin, "ls-remote", fx.origin, "refs/tags/v2")).toBe("");
  });

  test("the major never moves to a commit without the bundle", () => {
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
      /non-empty lib\/index\.js/,
    );
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
    expect(() =>
      verifyPublishedRefs({ cwd: checker, tag: "v2.1.0", sourceSha: fx.mergeSha }),
    ).toThrow();
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

describe("anchorBoundary", () => {
  test("last-release-sha advances to the merge commit on origin/main", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "anchor");
    const result = anchorBoundary({ cwd: dir, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(result.changed).toBe(true);
    const check = clone(fx.root, fx.origin, "anchor-check");
    const config = JSON.parse(readFileSync(join(check, "release-please-config.json"), "utf8")) as {
      "last-release-sha": string;
    };
    expect(config["last-release-sha"]).toBe(fx.mergeSha);
    expect(git(check, "log", "-1", "--format=%s")).toBe(
      "chore: anchor release-please to the v2.1.0 release",
    );
    // Idempotent: a rerun sees the recorded boundary and pushes nothing.
    const again = anchorBoundary({ cwd: check, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(again.changed).toBe(false);
  });

  test("a lost race is retried on the fresh head", () => {
    const fx = seedFixture();
    const anchor = clone(fx.root, fx.origin, "anchor-race");
    // A competing push lands after the anchor clone was taken.
    const racer = clone(fx.root, fx.origin, "racer");
    write(racer, "src/marker.ts", "export const marker = 7;\n");
    commitAll(racer, "fix: land between the release merge and the anchor");
    git(racer, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    const result = anchorBoundary({ cwd: anchor, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(result.changed).toBe(true);
    const check = clone(fx.root, fx.origin, "anchor-race-check");
    const config = JSON.parse(readFileSync(join(check, "release-please-config.json"), "utf8")) as {
      "last-release-sha": string;
    };
    expect(config["last-release-sha"]).toBe(fx.mergeSha);
    // Both the racer's commit and the anchor are on main.
    expect(git(check, "log", "--format=%s", "-3")).toContain("land between the release merge");
  });

  test("a stale rerun never drags the boundary backward", () => {
    const fx = seedFixture();
    const forward = clone(fx.root, fx.origin, "anchor-forward");
    anchorBoundary({ cwd: forward, tag: "v2.1.0", sourceSha: fx.mergeSha });
    // The old release's run replays its anchor with the older seed commit.
    const stale = clone(fx.root, fx.origin, "anchor-stale");
    const result = anchorBoundary({ cwd: stale, tag: "v2.0.0", sourceSha: fx.seedSha });
    expect(result.changed).toBe(false);
    const check = clone(fx.root, fx.origin, "anchor-stale-check");
    const config = JSON.parse(readFileSync(join(check, "release-please-config.json"), "utf8")) as {
      "last-release-sha": string;
    };
    expect(config["last-release-sha"]).toBe(fx.mergeSha);
  });
});
