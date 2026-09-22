/**
 * The release pipeline against local fixture repositories (a bare origin plus clones playing the CI checkouts), so the tag topology is a unit test
 * rather than what the first real release discovers.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import {
  anchorCheck,
  anchorReleasePr,
  boundaryCheck,
  FROZEN,
  type MainPosition,
  mainPosition,
  type NextVerdict,
  nextPublishVerdict,
  npmConfirm,
  npmVerdict,
  type Packument,
  type PublishVerdict,
  packageCommit,
  packageRelease,
  prereleaseVersion,
  prereleaseVersionOf,
  retagMajor,
  stablePublishVerdict,
} from "../../.github/scripts/release-pipeline.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";
import {
  ANCHOR_PUSH,
  BOT_IDENTITY,
  buildTagOf,
  buildTags,
  CHANGELOG_21,
  checkoutOf,
  clone,
  commitAll,
  createOf,
  expectPackage,
  FIXTURE_IDENTITY,
  type Fixture,
  git,
  guardRefusal,
  identityOf,
  installReleasePipelineFixture,
  LATEST,
  latestTag,
  localIdentity,
  moveOf,
  PERMANENT,
  PLANTED_PACKAGES,
  packagedOf,
  parentsOf,
  pushGreenCommit,
  remoteRef,
  rivalPackage,
  seedFixture,
  shallowClone,
  subcommand,
  withPushPlans,
  write,
  writeBuild,
} from "./release-pipeline-fixture.js";

// Dozens of git spawns per test time out bun's 5s default under parallel machine load.
setDefaultTimeout(60_000);
installReleasePipelineFixture();

describe("the fixture push guard", () => {
  test("a push from outside the fixture area is refused before git runs (negative control)", () =>
    withTempDir("not-a-release-pipeline-fixture-", (outside) => {
      const origin = join(outside, "origin.git");
      execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
      const repo = join(outside, "repo");
      execFileSync("git", ["clone", "--quiet", origin, repo]);
      git(repo, "config", "user.name", "fixture");
      git(repo, "config", "user.email", "fixture@example.invalid");
      git(repo, "config", "commit.gpgsign", "false");
      git(repo, "commit", "--quiet", "--allow-empty", "-m", "must never land");
      let error: unknown;
      try {
        execFileSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (thrown) {
        error = thrown;
      }
      expect((error as { status?: number }).status).toBe(1);
      expect(String((error as { stderr?: string }).stderr).trim()).toBe(
        guardRefusal(realpathSync(repo)),
      );
      expect(git(repo, "ls-remote", "origin", "refs/heads/main")).toBe("");
    }));

  test("a push from inside a fixture lands (positive control)", () => {
    const fx = seedFixture();
    git(fx.work, "push", "--quiet", "origin", `${fx.seedSha}:refs/heads/control`);
    expect(git(fx.origin, "rev-parse", "refs/heads/control")).toBe(fx.seedSha);
  });
});

describe("the fixture repositories", () => {
  /** The commands the git processes of a push from `fx.work` to `remote` spawn, as trace2 records them. */
  function spawnedByPush(fx: Fixture, remote: string): string[] {
    const trace = join(fx.root, `push-trace-${basename(remote)}.json`);
    execFileSync("git", ["push", "--quiet", remote, `${fx.seedSha}:refs/heads/probe`], {
      cwd: fx.work,
      env: { ...process.env, GIT_TRACE2_EVENT: trace },
    });
    return readFileSync(trace, "utf8")
      .split("\n")
      .filter((line) => line.includes('"event":"child_start"'))
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv.join(" "));
  }
  const MAINTENANCE = expect.stringContaining("maintenance run --auto");

  test("a push into the fixture origin spawns no background maintenance", () => {
    const fx = seedFixture();
    const spawned = spawnedByPush(fx, fx.origin);
    expect(spawned).toContainEqual(expect.stringContaining("receive-pack"));
    expect(spawned).not.toContainEqual(MAINTENANCE);
  });

  test("a push into a bare repository with maintenance on does (negative control)", () => {
    const fx = seedFixture();
    const plain = join(fx.root, "plain.git");
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", plain]);
    // Pinned rather than inherited, so a developer's global gitconfig cannot turn the control off.
    git(plain, "config", "maintenance.auto", "true");
    git(plain, "config", "receive.autogc", "true");
    // Synchronous, so the maintenance run ends before the fixture root goes.
    git(plain, "config", "maintenance.autoDetach", "false");
    expect(spawnedByPush(fx, plain)).toContainEqual(MAINTENANCE);
  });
});

const TAG = "refs/tags/v2.1.0";
const V2 = "refs/tags/v2";

describe("packageRelease", () => {
  test("a fresh release mints the merge commit's package under its build tag, tags it, and creates latest; a rerun verifies it and pushes nothing", () => {
    const fx = seedFixture();
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({
        cwd: fx.work,
        tag: "v2.1.0",
        sourceSha: fx.mergeSha,
        runUrl: "https://example.invalid/actions/runs/1",
      });
    });
    const packaged = git(fx.origin, "rev-parse", `${TAG}^{}`);
    const buildTag = buildTagOf(fx, fx.mergeSha);
    expect(result).toMatchObject({
      created: true,
      packagedSha: packaged,
      pruned: [],
      latest: { sha: packaged, changed: true },
    });
    expect(pushes).toEqual([
      createOf(packaged, buildTag),
      createOf(packaged, TAG),
      moveOf(LATEST, "", packaged),
    ]);
    expect(packagedOf(fx, fx.mergeSha)).toBe(packaged);
    expect(latestTag(fx)).toBe(packaged);
    expectPackage(
      fx,
      packaged,
      fx.mergeSha,
      "packaged-bundle-bytes-1",
      "https://example.invalid/actions/runs/1",
    );
    expect(localIdentity(fx.work)).toBe(FIXTURE_IDENTITY);

    const rerun = checkoutOf(fx, "rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let verified: ReturnType<typeof packageRelease> | undefined;
    const rerunPushes = withPushPlans(fx, [], () => {
      verified = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(verified).toMatchObject({
      created: false,
      packagedSha: packaged,
      pruned: [],
      latest: { sha: packaged, changed: false },
    });
    expect(rerunPushes).toEqual([]);
    expect(git(fx.origin, "rev-parse", `${TAG}^{}`)).toBe(packaged);
    expect(buildTags(fx)).toEqual([buildTag]);
  });

  test("a release whose package post-green already minted is tagged there, with no second package", () => {
    const fx = seedFixture();
    const packaged = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha }).commit;
    const release = checkoutOf(fx, "release", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: release, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(result).toMatchObject({
      created: true,
      packagedSha: packaged,
      pruned: [],
      latest: { sha: packaged, changed: false },
    });
    expect(pushes).toEqual([createOf(packaged, TAG)]);
    expect(git(fx.origin, "rev-parse", `${TAG}^{}`)).toBe(packaged);
    expect(buildTags(fx)).toEqual([buildTagOf(fx, fx.mergeSha)]);
  });

  test("a release behind newer green commits is tagged on its own package and leaves latest on the newest", () => {
    const fx = seedFixture();
    const packaged = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha }).commit;
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const newer = packageCommit({ cwd: next.dir, sourceSha: next.sha }).commit;
    const release = checkoutOf(fx, "release", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: release, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(result).toMatchObject({
      created: true,
      packagedSha: packaged,
      pruned: [],
      latest: { sha: newer, changed: false },
    });
    expect(pushes).toEqual([createOf(packaged, TAG)]);
    expect(git(fx.origin, "rev-parse", `${TAG}^{}`)).toBe(packaged);
    expect(latestTag(fx)).toBe(newer);
  });

  test("a release post-green skipped mints its package behind a newer commit's, and latest stays on the newer one", () => {
    const fx = seedFixture();
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const newer = packageCommit({ cwd: next.dir, sourceSha: next.sha }).commit;
    const release = checkoutOf(fx, "release", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: release, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    const packaged = packagedOf(fx, fx.mergeSha);
    expect(result).toMatchObject({
      created: true,
      packagedSha: packaged,
      pruned: [],
      latest: { sha: newer, changed: false },
    });
    expect(pushes).toEqual([
      createOf(packaged, buildTagOf(fx, fx.mergeSha)),
      createOf(packaged, TAG),
    ]);
    expect(parentsOf(fx.origin, packaged)).toEqual([fx.mergeSha]);
    expect(latestTag(fx)).toBe(newer);
  });

  test("a first release whose latest move failed is healed by its rerun", () => {
    const fx = seedFixture();
    const stderr = PERMANENT[0]?.[1] ?? "";
    let error: unknown;
    const pushes = withPushPlans(fx, [null, null, { fail: { stderr, status: 128 } }], () => {
      try {
        packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
      } catch (thrown) {
        error = thrown;
      }
    });
    const packaged = git(fx.origin, "rev-parse", `${TAG}^{}`);
    expect(pushes).toEqual([
      createOf(packaged, buildTagOf(fx, fx.mergeSha)),
      createOf(packaged, TAG),
      moveOf(LATEST, "", packaged),
    ]);
    expect(error).toEqual(
      new Error(
        `git push --force-with-lease=${LATEST}: origin ${packaged}:${LATEST} failed: ${stderr.trim()}`,
      ),
    );
    expect(remoteRef(fx, LATEST)).toBe("");
    const rerun = checkoutOf(fx, "rerun-heal", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const rerunPushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(result).toMatchObject({
      created: false,
      packagedSha: packaged,
      pruned: [],
      latest: { sha: packaged, changed: true },
    });
    expect(rerunPushes).toEqual([moveOf(LATEST, "", packaged)]);
    expect(latestTag(fx)).toBe(packaged);
  });

  test("a rival run tagging the release between the read and the push is verified, and its commit is what the run reports", () => {
    const fx = seedFixture();
    // A hand-shaped race: two runs of one release share the build tag, so only a hand push can tag another
    // commit; a rival with the same build passes the byte check and is adopted.
    const rival = rivalPackage(fx, "rival-same", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(
      fx,
      [null, { competitor: { from: rival.from, sha: rival.sha, ref: TAG } }],
      () => {
        result = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
      },
    );
    const own = packagedOf(fx, fx.mergeSha);
    expect(own).not.toBe(rival.sha);
    expect(result).toMatchObject({
      created: false,
      packagedSha: rival.sha,
      pruned: [],
      latest: { sha: rival.sha, changed: true },
    });
    expect(pushes).toEqual([
      createOf(own, buildTagOf(fx, fx.mergeSha)),
      createOf(own, TAG),
      moveOf(LATEST, "", rival.sha),
    ]);
    expect(git(fx.origin, "rev-parse", `${TAG}^{}`)).toBe(rival.sha);
  });

  /** What a rerun's rebuild can get wrong under the packaged paths; every one is a tree the tag does not carry. */
  const drifted: [string, (rerun: string) => void][] = [
    ["the action bundle's bytes", (rerun) => write(rerun, "lib/index.js", "DIFFERENT-bytes\n")],
    [
      "the library declarations' bytes",
      (rerun) => write(rerun, "lib/pkg/index.d.ts", "DIFFERENT-types\n"),
    ],
    ["an extra library file", (rerun) => write(rerun, "lib/pkg/chunk.js", "extra\n")],
  ];
  test.each(drifted)("a rerun whose rebuild differs in %s stops loudly", (_name, drift) => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const before = git(fx.origin, "rev-parse", `${TAG}^{}`);
    const rerun = checkoutOf(fx, "rerun-drift", fx.mergeSha, "packaged-bundle-bytes-1\n");
    drift(rerun);
    expect(() => packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      new RegExp(
        `^${TAG} \\(${before}\\) packages ${fx.mergeSha}, but its tree [0-9a-f]{40} is not the tree [0-9a-f]{40} this checkout's build packages, .*Diff the two trees by hand; ${RegExp.escape(FROZEN)}$`,
      ),
    );
    expect(git(fx.origin, "rev-parse", `${TAG}^{}`)).toBe(before);
  });

  test.each(PLANTED_PACKAGES)(
    "an existing version tag on %s stops package and retag-major, and nothing moves",
    (_name, plant) => {
      const fx = seedFixture();
      const { from, sha, error } = plant(fx);
      git(from, "push", "--quiet", "origin", `${sha}:${TAG}`);
      const frozen = new RegExp(`${RegExp.escape(FROZEN)}$`);
      const pushes = withPushPlans(fx, [], () => {
        for (const path of [
          () => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha }),
          () => retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha }),
        ]) {
          expect(path).toThrow(error);
          expect(path).toThrow(frozen);
        }
      });
      expect(pushes).toEqual([]);
      expect(git(fx.origin, "rev-parse", `${TAG}^{}`)).toBe(sha);
      expect(remoteRef(fx, LATEST)).toBe("");
      expect(buildTags(fx)).toEqual([]);
    },
  );

  test("a checkout that is not the merge commit refuses to package", () => {
    const fx = seedFixture();
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.seedSha })).toThrow(
      /not the source commit .* to package/,
    );
  });

  test("a source that never reached main is refused before any push, however well its manifest matches", () => {
    const fx = seedFixture();
    // A release-shaped commit on a side branch: what a draft whose target is not the merge commit would hand the hook.
    const side = clone(fx.root, fx.origin, "off-main-release");
    git(side, "checkout", "--quiet", "-b", "side", fx.seedSha);
    write(side, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.1.0" }, null, 2)}\n`);
    const sideSha = commitAll(side, "chore(main): release 2.1.0 (#43)");
    git(side, "push", "--quiet", "origin", "HEAD:refs/heads/side");
    writeBuild(side, "packaged-bundle-bytes-1\n");
    let error: unknown;
    const pushes = withPushPlans(fx, [], () => {
      try {
        packageRelease({ cwd: side, tag: "v2.1.0", sourceSha: sideSha });
      } catch (thrown) {
        error = thrown;
      }
    });
    expect(error).toEqual(
      new Error(
        `${sideSha} is not on origin's main (its head is ${fx.mergeSha}); refusing to package, tag, or publish a commit main does not hold.`,
      ),
    );
    expect(pushes).toEqual([]);
    expect(buildTags(fx)).toEqual([]);
    expect(remoteRef(fx, TAG)).toBe("");
    expect(remoteRef(fx, LATEST)).toBe("");
  });

  test.each<[tag: string, error: RegExp]>([
    ["v2.1-rc.0", /not a vX\.Y\.Z release tag/],
    // Well-shaped, but not the version this source's manifest released.
    ["v2.2.0", /did not release/],
  ])("the tag %s mints nothing", (tag, error) => {
    const fx = seedFixture();
    expect(() => packageRelease({ cwd: fx.work, tag, sourceSha: fx.mergeSha })).toThrow(error);
    expect(remoteRef(fx, `refs/tags/${tag}`)).toBe("");
    expect(buildTags(fx)).toEqual([]);
  });

  // The build the packaged commit must carry, spoiled two ways; the shared check refuses both entry points before
  // any push. The entry shown for the empty file is git's empty blob at ls-tree's size column.
  const unbuilt = ["lib/index.js", "lib/pkg/index.js"].flatMap(
    (file): [state: string, file: string, spoil: (dir: string) => void, entry: string][] => [
      [
        "an empty",
        file,
        (dir) => write(dir, file, ""),
        "entry 100644 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 +0",
      ],
      ["a missing", file, (dir) => rmSync(join(dir, file)), "no entry"],
    ],
  );
  test.each(unbuilt)(
    "%s %s refuses to package and never reaches origin",
    (_state, file, spoil, entry) => {
      const fx = seedFixture();
      spoil(fx.work);
      const message = new RegExp(
        `does not carry a non-empty regular-file ${RegExp.escape(file)} \\(${entry}\\); refusing to point a consumable ref at an unpackaged commit; run the build before packaging\\.$`,
      );
      expect(() => packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(message);
      expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
        message,
      );
      expect(buildTags(fx)).toEqual([]);
      expect(remoteRef(fx, LATEST)).toBe("");
    },
  );

  test("a worktree dirty beyond the build outputs refuses to package", () => {
    const fx = seedFixture();
    write(fx.work, "src/marker.ts", "export const marker = 999;\n");
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /pending changes beyond lib\/index\.js and lib\/pkg\//,
    );
    expect(remoteRef(fx, TAG)).toBe("");
    expect(buildTags(fx)).toEqual([]);
  });

  test("a shallow checkout is refused before any verdict", () => {
    const fx = seedFixture();
    const dir = shallowClone(fx, "shallow");
    writeBuild(dir, "packaged-bundle-bytes-1\n");
    expect(() => packageRelease({ cwd: dir, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /^package needs the full history \(fetch-depth: 0\) and this checkout is shallow/,
    );
    expect(remoteRef(fx, TAG)).toBe("");
  });
});

/**
 * The next release's merge on origin/main, prepared from a fresh clone as CI sees it: the previous release's
 * packaged commit lives under its tags, never in a working branch.
 */
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
  writeBuild(dir, bundle);
  return { dir, mergeSha };
}

describe("retagMajor", () => {
  test("the major is created on the verified package, follows the next release forward, and a rerun of the older release's job leaves it there", () => {
    const fx = seedFixture();
    const { packagedSha } = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    let moved: ReturnType<typeof retagMajor> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      moved = retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(moved).toMatchObject({
      major: "v2",
      packagedSha,
      move: { sha: packagedSha, changed: true },
    });
    expect(pushes).toEqual([moveOf(V2, "", packagedSha)]);
    expect(git(fx.origin, "rev-parse", `${V2}^{}`)).toBe(packagedSha);
    expect(identityOf(fx.origin, packagedSha)).toBe(BOT_IDENTITY);
    expect(localIdentity(fx.work)).toBe(FIXTURE_IDENTITY);

    const next = prepareNextRelease(fx, "2.1.1", 44, "packaged-bundle-bytes-2\n");
    const newer = packageRelease({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    let forward: ReturnType<typeof retagMajor> | undefined;
    const forwardPushes = withPushPlans(fx, [], () => {
      forward = retagMajor({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    });
    expect(forward).toMatchObject({
      major: "v2",
      packagedSha: newer.packagedSha,
      move: { sha: newer.packagedSha, changed: true },
    });
    expect(forwardPushes).toEqual([moveOf(V2, packagedSha, newer.packagedSha)]);
    expect(git(fx.origin, "rev-parse", `${V2}^{}`)).toBe(newer.packagedSha);
    expect(parentsOf(fx.origin, newer.packagedSha)).toEqual([next.mergeSha]);

    const stale = checkoutOf(fx, "stale-rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    expect(packageRelease({ cwd: stale, tag: "v2.1.0", sourceSha: fx.mergeSha })).toMatchObject({
      created: false,
      packagedSha,
      pruned: [],
      latest: { sha: newer.packagedSha, changed: false },
    });
    let left: ReturnType<typeof retagMajor> | undefined;
    const stalePushes = withPushPlans(fx, [], () => {
      left = retagMajor({ cwd: stale, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(left).toMatchObject({
      major: "v2",
      packagedSha,
      move: { sha: newer.packagedSha, changed: false },
    });
    expect(stalePushes).toEqual([]);
    expect(git(fx.origin, "rev-parse", `${V2}^{}`)).toBe(newer.packagedSha);
  });

  test("the major never moves to a package of the wrong source", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(() => retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.seedSha })).toThrow(
      new RegExp(`has parent ${fx.mergeSha}, so it is no package of ${fx.seedSha}`),
    );
    expect(remoteRef(fx, V2)).toBe("");
  });

  test("the major never moves to a commit that is not a pure package", () => {
    const fx = seedFixture();
    const planter = clone(fx.root, fx.origin, "planter-empty");
    git(planter, "checkout", "--quiet", fx.mergeSha);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    git(planter, "commit", "--quiet", "--allow-empty", "-m", "build: by hand");
    git(planter, "tag", "v2.1.0");
    git(planter, "push", "--quiet", "origin", TAG);
    const mover = clone(fx.root, fx.origin, "mover-empty");
    expect(() => retagMajor({ cwd: mover, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /is not [0-9a-f]{40} plus lib\/index\.js and lib\/pkg\/, minus package\.json's preparation scripts, alone/,
    );
    expect(remoteRef(fx, V2)).toBe("");
  });

  test("a newer release landing between the major's read and the lease push is left in place: the re-read finds the major past this release", () => {
    const fx = seedFixture();
    const older = packageRelease({
      cwd: fx.work,
      tag: "v2.1.0",
      sourceSha: fx.mergeSha,
    }).packagedSha;
    retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const next = prepareNextRelease(fx, "2.1.1", 44, "packaged-bundle-bytes-2\n");
    const newer = packageRelease({
      cwd: next.dir,
      tag: "v2.1.1",
      sourceSha: next.mergeSha,
    }).packagedSha;
    const stale = checkoutOf(fx, "stale-rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    // v2 sits on a bare main commit when the rerun reads it, so the rerun has a move to make; the 2.1.1 job takes v2
    // right before the rerun's push lands, so the lease on the value it read is stale and the re-read finds v2 past
    // this release.
    git(fx.work, "push", "--quiet", "--force", "origin", `${fx.seedSha}:${V2}`);
    let result: ReturnType<typeof retagMajor> | undefined;
    const pushes = withPushPlans(
      fx,
      [{ competitor: { from: next.dir, sha: newer, ref: V2 } }],
      () => {
        result = retagMajor({ cwd: stale, tag: "v2.1.0", sourceSha: fx.mergeSha });
      },
    );
    expect(result).toMatchObject({
      major: "v2",
      packagedSha: older,
      move: { sha: newer, changed: false },
    });
    expect(pushes).toEqual([moveOf(V2, fx.seedSha, older)]);
    expect(git(fx.origin, "rev-parse", `${V2}^{}`)).toBe(newer);
  });

  test("a lease overtaken by a hand move to a bare main commit is retried on the re-observed value and replaces it", () => {
    const fx = seedFixture();
    const { packagedSha } = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    let result: ReturnType<typeof retagMajor> | undefined;
    const pushes = withPushPlans(
      fx,
      [{ competitor: { from: fx.work, sha: fx.seedSha, ref: V2 } }],
      () => {
        result = retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
      },
    );
    expect(result).toMatchObject({
      major: "v2",
      packagedSha,
      move: { sha: packagedSha, changed: true },
    });
    expect(pushes).toEqual([moveOf(V2, "", packagedSha), moveOf(V2, fx.seedSha, packagedSha)]);
    expect(git(fx.origin, "rev-parse", `${V2}^{}`)).toBe(packagedSha);
  });

  test("a lease overtaken on every attempt gives up naming the concurrent mover", () => {
    const fx = seedFixture();
    const { packagedSha } = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const movers = [fx.seedSha, fx.mergeSha, fx.seedSha];
    const pushes = withPushPlans(
      fx,
      movers.map((sha) => ({ competitor: { from: fx.work, sha, ref: V2 } })),
      () => {
        expect(() => retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
          `could not move ${V2} after 3 compare-and-swap attempts; something keeps moving it concurrently - rerun this job once it settles.`,
        );
      },
    );
    expect(pushes).toEqual([
      moveOf(V2, "", packagedSha),
      moveOf(V2, fx.seedSha, packagedSha),
      moveOf(V2, fx.mergeSha, packagedSha),
    ]);
    expect(git(fx.origin, "rev-parse", `${V2}^{}`)).toBe(fx.seedSha);
  });

  test.each(PERMANENT)(
    "%s fails the first lease push for good, with git's own words",
    (_name, stderr) => {
      const fx = seedFixture();
      const { packagedSha } = packageRelease({
        cwd: fx.work,
        tag: "v2.1.0",
        sourceSha: fx.mergeSha,
      });
      let error: unknown;
      const pushes = withPushPlans(fx, [{ fail: { stderr, status: 128 } }], () => {
        try {
          retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
        } catch (thrown) {
          error = thrown;
        }
      });
      expect(pushes).toEqual([moveOf(V2, "", packagedSha)]);
      expect(error).toEqual(
        new Error(
          `git push --force-with-lease=${V2}: origin ${packagedSha}:${V2} failed: ${stderr.trim()}`,
        ),
      );
      expect(remoteRef(fx, V2)).toBe("");
    },
  );
});

/** release-please's PR branch: manifest and changelog bumped to `version` on `from`; left unpushed for a competitor plan when `push` is false. */
function createReleasePrBranch(
  fx: Fixture,
  from: string,
  version: string,
  push = true,
): { dir: string; sha: string } {
  const dir = clone(fx.root, fx.origin, `rp-branch-${version}-${from.slice(0, 7)}`);
  git(dir, "checkout", "--quiet", "-B", "release-please--branches--main", from);
  write(dir, ".release-please-manifest.json", `${JSON.stringify({ ".": version }, null, 2)}\n`);
  write(
    dir,
    "CHANGELOG.md",
    `# Changelog\n\n## [${version}](https://example.invalid/compare) (2026-08-14)\n\n### Bug Fixes\n\n* the fix ([abc1234](https://example.invalid/commit/abc1234))\n${CHANGELOG_21}`,
  );
  const sha = commitAll(dir, `chore(main): release ${version}`);
  if (push) {
    git(
      dir,
      "push",
      "--quiet",
      "--force",
      "origin",
      "HEAD:refs/heads/release-please--branches--main",
    );
  }
  return { dir, sha };
}

function releasePrConfig(fx: Fixture, name: string): { boundary: string; manifest: string } {
  const check = clone(fx.root, fx.origin, name);
  git(check, "checkout", "--quiet", "release-please--branches--main");
  const config = JSON.parse(readFileSync(join(check, "release-please-config.json"), "utf8")) as {
    "last-release-sha": string;
  };
  return {
    boundary: config["last-release-sha"],
    manifest: readFileSync(join(check, ".release-please-manifest.json"), "utf8"),
  };
}

describe("anchorReleasePr", () => {
  test("the boundary lands inside the release PR branch and merges onto main", () => {
    const fx = seedFixture();
    const mainHead = fx.mergeSha;
    createReleasePrBranch(fx, mainHead, "2.2.0");
    const worker = clone(fx.root, fx.origin, "anchor-worker");
    const result = anchorReleasePr({ cwd: worker, sourceSha: mainHead });
    expect(result.changed).toBe(true);
    expect(identityOf(worker, "HEAD")).toBe(BOT_IDENTITY);
    expect(localIdentity(worker)).toBe(FIXTURE_IDENTITY);
    const check = clone(fx.root, fx.origin, "anchor-check");
    git(check, "checkout", "--quiet", "release-please--branches--main");
    const config = JSON.parse(readFileSync(join(check, "release-please-config.json"), "utf8")) as {
      "last-release-sha": string;
    };
    expect(config["last-release-sha"]).toBe(mainHead);
    expect(readFileSync(join(check, ".release-please-manifest.json"), "utf8")).toContain("2.2.0");
    const again = anchorReleasePr({
      cwd: clone(fx.root, fx.origin, "anchor-again"),
      sourceSha: mainHead,
    });
    expect(again.changed).toBe(false);
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
    expect(result).toMatchObject({ changed: false, reason: "no release PR branch to anchor" });
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
    // The branch was refreshed from the SEED while main moved on to the 2.1.0 merge; anchoring mergeSha would record a boundary its content was not
    // computed from.
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
    // The refresh force-push wipes the anchor commit; the SAME clone must fetch the rewritten branch (a locally checked-out branch would make git
    // refuse the fetch).
    createReleasePrBranch(fx, fx.mergeSha, "2.3.0");
    expect(anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha }).changed).toBe(true);
    expect(releasePrConfig(fx, "anchor-twice-check").boundary).toBe(fx.mergeSha);
  });

  test("a push overtaken by a refresh mid-anchor is reapplied on the refreshed branch", () => {
    const fx = seedFixture();
    createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
    const refresh = createReleasePrBranch(fx, fx.mergeSha, "2.3.0", false);
    const worker = clone(fx.root, fx.origin, "anchor-raced");
    let result: ReturnType<typeof anchorReleasePr> | undefined;
    const pushes = withPushPlans(
      fx,
      [
        {
          competitor: {
            from: refresh.dir,
            sha: refresh.sha,
            ref: "refs/heads/release-please--branches--main",
          },
        },
      ],
      () => {
        result = anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha });
      },
    );
    expect(result).toMatchObject({
      changed: true,
      reason: `release-please--branches--main: anchored at ${fx.mergeSha}`,
    });
    expect(pushes).toEqual([ANCHOR_PUSH, ANCHOR_PUSH]);
    const anchored = releasePrConfig(fx, "anchor-raced-check");
    expect(anchored.boundary).toBe(fx.mergeSha);
    expect(anchored.manifest).toContain("2.3.0");
    expect(git(fx.origin, "rev-parse", "refs/heads/release-please--branches--main^")).toBe(
      refresh.sha,
    );
  });

  test("a push overtaken on every attempt gives up naming the rewriter", () => {
    const fx = seedFixture();
    createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
    const refreshes = ["2.3.0", "2.4.0", "2.5.0"].map((v) =>
      createReleasePrBranch(fx, fx.mergeSha, v, false),
    );
    const worker = clone(fx.root, fx.origin, "anchor-lost");
    const pushes = withPushPlans(
      fx,
      refreshes.map((r) => ({
        competitor: { from: r.dir, sha: r.sha, ref: "refs/heads/release-please--branches--main" },
      })),
      () => {
        expect(() => anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha })).toThrow(
          "could not anchor release-please--branches--main after 3 attempts; something keeps rewriting the branch - rerun this job once the branch settles.",
        );
      },
    );
    expect(pushes).toEqual([ANCHOR_PUSH, ANCHOR_PUSH, ANCHOR_PUSH]);
    expect(git(fx.origin, "rev-parse", "refs/heads/release-please--branches--main")).toBe(
      refreshes[2]?.sha ?? "",
    );
  });

  test.each(PERMANENT)(
    "%s fails the first anchor push for good, with git's own words",
    (_name, stderr) => {
      const fx = seedFixture();
      const branch = createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
      const worker = clone(fx.root, fx.origin, "anchor-denied");
      let error: unknown;
      const pushes = withPushPlans(fx, [{ fail: { stderr, status: 128 } }], () => {
        try {
          anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha });
        } catch (thrown) {
          error = thrown;
        }
      });
      expect(pushes).toEqual([ANCHOR_PUSH]);
      expect(error).toEqual(
        new Error(
          `git push origin HEAD:refs/heads/release-please--branches--main failed: ${stderr.trim()}`,
        ),
      );
      expect(git(fx.origin, "rev-parse", "refs/heads/release-please--branches--main")).toBe(
        branch.sha,
      );
    },
  );
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
    // The seed commit records a placeholder boundary and has no release merge behind it.
    git(dir, "checkout", "--quiet", fx.seedSha);
    expect(() => boundaryCheck(dir)).toThrow(/not on this history at all/);
  });

  test("a shallow checkout is refused before any verdict", () => {
    const fx = seedFixture();
    // The release merge is within depth 2 but its parent, the recorded boundary, is not: a truncated history would call it stale.
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
    // The 2.2.0 release PR merged under a subject RELEASE_SUBJECT does not match, so the 2.1.0 merge stays the newest recognized one while the
    // boundary sits after it.
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
    // A descendant of the release merge that never landed on main: the stale message's rollback IS the repair.
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
    // Newer than the release merge and sharing its prefix, but not its shape: must neither become the boundary nor park the check.
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

describe("release configuration contract", () => {
  test("the committed config pins the tagless-draft knobs (shape only; the flow itself is not exercised here)", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8")) as {
      "skip-github-release"?: unknown;
      "include-component-in-tag"?: unknown;
      "last-release-sha"?: unknown;
      packages: Record<string, Record<string, unknown>>;
    };
    const root = config.packages["."];
    // release-please must never create a tag on main; the hook mints the only tag, on the merge commit's packaged commit.
    //   draft: true + force-tag-creation: false  -> explicit, since the upstream default could change
    //   include-component-in-tag: false          -> tags stay strictly vX.Y.Z, the one shape releaseMajor() accepts
    //   skip-github-release unset                -> set, release_created never fires and the hook never runs
    expect(root?.draft).toBe(true);
    expect(root?.["force-tag-creation"]).toBe(false);
    expect(config["skip-github-release"]).toBeUndefined();
    expect(config["include-component-in-tag"]).toBe(false);
    expect(typeof config["last-release-sha"]).toBe("string");
  });
});

/** The version grammar as semver.org states it: what npm holds a version to
 * before it normalizes one (a bare all-digit identifier loses its leading zero). */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

describe("prereleaseVersion", () => {
  const sha = "b8df084c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a";
  const at = (count: number, date = "20260913"): MainPosition => ({ count, date });
  const minted: [string, MainPosition, string, string][] = [
    ["2.0.0", at(446), sha, "2.0.1-main.446.20260913.gb8df084"],
    ["2.9.9", at(7, "20250101"), sha, "2.9.10-main.7.20250101.gb8df084"],
    ["0.0.0", at(1), sha, "0.0.1-main.1.20260913.gb8df084"],
    // The sha7 that would be rewritten to 123456 as a bare identifier.
    [
      "2.0.0",
      at(446),
      "0123456789abcdef0123456789abcdef01234567",
      "2.0.1-main.446.20260913.g0123456",
    ],
  ];
  test.each(minted)("manifest %s at %j of %s mints %s", (manifest, position, source, expected) => {
    const version = prereleaseVersion(manifest, position, source);
    expect(version).toBe(expected);
    expect(version).toMatch(SEMVER);
  });

  const refusedInputs: [string, [string, MainPosition, string], RegExp][] = [
    ["a manifest version with a pre-release", ["2.0.0-rc.1", at(446), sha], /is not X\.Y\.Z/],
    ["a manifest version missing its patch", ["2.0", at(446), sha], /is not X\.Y\.Z/],
    ["a commit count of zero", ["2.0.0", at(0), sha], /not a positive integer/],
    ["a fractional commit count", ["2.0.0", at(1.5), sha], /not a positive integer/],
    ["a short sha", ["2.0.0", at(446), "b8df084"], /not a full commit sha/],
    ["an upper-case sha", ["2.0.0", at(446), sha.toUpperCase()], /not a full commit sha/],
  ];
  test.each(refusedInputs)("%s is refused", (_name, args, error) => {
    expect(() => prereleaseVersion(...args)).toThrow(error);
  });

  /** A commit's committer date as UTC YYYYMMDD, by git's own formatter: the pipeline computes it from %ct instead. */
  function utcDate(cwd: string, sha: string): string {
    return execFileSync("git", ["log", "-1", "--format=%cd", "--date=format-local:%Y%m%d", sha], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    }).trim();
  }

  /** The version the fixture's 2.1.0 manifest mints for a main commit at the given first-parent count. */
  const versionOf = (cwd: string, sha: string, count: number): string =>
    `2.1.1-main.${count}.${utcDate(cwd, sha)}.g${sha.slice(0, 7)}`;

  /** Late on the 13th in New York is the 14th in UTC: the merge commit below is stamped with it. */
  const COMMITTED = "2026-09-13T23:30:00-04:00";

  /** A two-commit topic branch merged into main with a merge commit, pushed, and fetched into the work clone:
   * the one shape of main history where the first-parent count and the plain count differ. */
  function mergeTopicOnMain(fx: Fixture): string {
    const later = clone(fx.root, fx.origin, "later");
    git(later, "checkout", "--quiet", "-b", "topic");
    write(later, "src/topic.ts", "export const topic = 1;\n");
    commitAll(later, "feat: topic, part one");
    write(later, "src/topic.ts", "export const topic = 2;\n");
    commitAll(later, "feat: topic, part two");
    git(later, "checkout", "--quiet", "main");
    execFileSync("git", ["merge", "--quiet", "--no-ff", "--no-edit", "topic"], {
      cwd: later,
      env: { ...process.env, GIT_COMMITTER_DATE: COMMITTED },
    });
    const merged = git(later, "rev-parse", "HEAD");
    git(later, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    git(fx.work, "fetch", "--quiet", "origin");
    return merged;
  }

  test("the position counts main's commits along first parents under the source, and dates it in UTC", () => {
    const fx = seedFixture();
    const merged = mergeTopicOnMain(fx);
    // Five commits are reachable from the merge; three lie on main's first-parent line.
    expect(git(fx.work, "rev-list", "--count", merged)).toBe("5");
    expect(mainPosition(fx.work, fx.seedSha)).toEqual({
      count: 1,
      date: utcDate(fx.work, fx.seedSha),
    });
    expect(mainPosition(fx.work, fx.mergeSha)).toEqual({
      count: 2,
      date: utcDate(fx.work, fx.mergeSha),
    });
    expect(mainPosition(fx.work, merged)).toEqual({ count: 3, date: "20260914" });
  });

  test("the checkout's version names the manifest at HEAD and the source's position, which HEAD must be; a rerun mints the same string", () => {
    const fx = seedFixture();
    expect(prereleaseVersionOf({ cwd: fx.work, sourceSha: fx.mergeSha })).toBe(
      versionOf(fx.work, fx.mergeSha, 2),
    );
    expect(() => prereleaseVersionOf({ cwd: fx.work, sourceSha: fx.seedSha })).toThrow(
      `the checkout is at ${fx.mergeSha}, not the source commit ${fx.seedSha} whose build is published.`,
    );
    const merged = mergeTopicOnMain(fx);
    const judge = checkoutOf(fx, "judge", merged, "packaged-bundle-bytes-2\n");
    const first = prereleaseVersionOf({ cwd: judge, sourceSha: merged });
    expect(first).toBe(`2.1.1-main.3.20260914.g${merged.slice(0, 7)}`);
    const rerun = checkoutOf(fx, "judge-rerun", merged, "packaged-bundle-bytes-3\n");
    expect(prereleaseVersionOf({ cwd: rerun, sourceSha: merged })).toBe(first);
  });

  test("a shallow checkout is refused: its count would stop at the shallow boundary", () => {
    const fx = seedFixture();
    const checker = shallowClone(fx, "shallow");
    const head = git(checker, "rev-parse", "HEAD");
    expect(() => prereleaseVersionOf({ cwd: checker, sourceSha: head })).toThrow(
      "the pre-release version needs the full history (fetch-depth: 0) and this checkout is shallow: the count of commits under the source would stop at the shallow boundary.",
    );
  });

  test("the subcommand prints the version alone on stdout from GITHUB_SHA alone, and nothing there when it fails", async () => {
    const fx = seedFixture();
    expect(await subcommand(fx.work, { GITHUB_SHA: fx.mergeSha }, "prerelease-version")).toEqual({
      stdout: `${versionOf(fx.work, fx.mergeSha, 2)}\n`,
      stderr: "",
      status: 0,
    });
    expect(await subcommand(fx.work, { GITHUB_SHA: undefined }, "prerelease-version")).toEqual({
      stdout: "",
      stderr:
        'release-pipeline prerelease-version: GITHUB_SHA is required for "prerelease-version"\n',
      status: 1,
    });
  });

  test("a latest this pipeline never minted stops the stable verdict, not ordered", () => {
    expect(() =>
      stablePublishVerdict("2.1.0", { versions: {}, "dist-tags": { latest: "2.0.1-beta.1" } }),
    ).toThrow(/not a version this pipeline mints/);
  });

  const registry = (versions: string[], tags: Record<string, string>): Packument => ({
    versions: Object.fromEntries(versions.map((v) => [v, {}])),
    "dist-tags": tags,
  });

  /** The registry states the next guard meets, around one source: the fixture's release merge, judged from the
   * work clone after main grew two commits past it and a branch left it unmerged. */
  function mainAround(fx: Fixture): {
    own: string;
    ancestor: string;
    descendant: string;
    further: string;
    unrelated: string;
  } {
    const after = pushGreenCommit(fx, "after", "packaged-bundle-bytes-2\n");
    const further = pushGreenCommit(fx, "further", "packaged-bundle-bytes-3\n");
    const side = clone(fx.root, fx.origin, "side");
    git(side, "checkout", "--quiet", fx.seedSha);
    write(side, "src/side.ts", "export const side = 1;\n");
    const sideSha = commitAll(side, "feat: off main");
    git(side, "push", "--quiet", "origin", "HEAD:refs/heads/side");
    git(fx.work, "fetch", "--quiet", "origin");
    return {
      own: versionOf(fx.work, fx.mergeSha, 2),
      ancestor: versionOf(fx.work, fx.seedSha, 1),
      descendant: versionOf(fx.work, after.sha, 3),
      further: versionOf(fx.work, further.sha, 4),
      unrelated: versionOf(fx.work, sideSha, 2),
    };
  }

  test("next: a published pre-release is placed by its source's ancestry; a rerun, or a descendant's pre-release, holds the run back, and nothing else does", () => {
    const fx = seedFixture();
    const main = mainAround(fx);
    const source7 = fx.mergeSha.slice(0, 7);
    const sha7 = (version: string): string => version.slice(-7);
    const staleReason = (version: string): string =>
      `the registry already holds ${version}, whose source ${sha7(version)} is a descendant of ${source7} on main, so this stale run publishes nothing (npm publish --tag next would move next back)`;
    const stale = (version: string): NextVerdict => ({
      publish: false,
      version: main.own,
      reason: staleReason(version),
      notices: [],
    });
    const goes = (...notices: string[]): NextVerdict => ({
      publish: true,
      version: main.own,
      notices,
    });
    const unresolved = "2.1.1-main.9.20260901.g0000000";
    const cases: [string, Packument | null, NextVerdict][] = [
      ["a package the registry has never seen", null, goes()],
      ["the first pre-release after a release", registry(["2.1.0"], { latest: "2.1.0" }), goes()],
      [
        "an ancestor's pre-release on next",
        registry(["2.1.0", main.ancestor], { latest: "2.1.0", next: main.ancestor }),
        goes(),
      ],
      [
        "next naming this run's own version while the record lacks it: a rerun, npm would refuse the version",
        registry(["2.1.0"], { latest: "2.1.0", next: main.own }),
        {
          publish: false,
          version: main.own,
          reason: `${main.own} is already on the registry`,
          notices: [],
        },
      ],
      [
        "next naming a release, which carries no source",
        registry(["2.1.0"], { latest: "2.1.0", next: "2.1.0" }),
        goes(),
      ],
      [
        "a descendant's pre-release with other position identifiers (the hand bootstrap's shape): the sha alone places it",
        registry([`2.1.1-main.0.g${sha7(main.descendant)}`], {
          latest: `2.1.1-main.0.g${sha7(main.descendant)}`,
          next: `2.1.1-main.0.g${sha7(main.descendant)}`,
        }),
        stale(`2.1.1-main.0.g${sha7(main.descendant)}`),
      ],
      [
        "a rerun of a run that already published",
        registry(["2.1.0", main.own], { latest: "2.1.0", next: main.own }),
        {
          publish: false,
          version: main.own,
          reason: `${main.own} is already on the registry`,
          notices: [],
        },
      ],
      [
        "a descendant's pre-release, whatever the dist-tags name",
        registry(["2.1.0", main.ancestor, main.descendant], {
          latest: "2.1.0",
          next: main.ancestor,
        }),
        stale(main.descendant),
      ],
      [
        "two descendants' pre-releases: the furthest along main is named",
        registry(["2.1.0", main.further, main.descendant], { latest: "2.1.0", next: main.further }),
        stale(main.further),
      ],
      [
        "a release that shipped after this commit, with no pre-release of its merge",
        registry(["2.1.0", "2.2.0"], { latest: "2.2.0" }),
        goes(),
      ],
      [
        "a pre-release naming a commit this checkout lacks, on next",
        registry(["2.1.0", unresolved], { latest: "2.1.0", next: unresolved }),
        goes(`${unresolved} names 0000000, which is no commit in this checkout; ignored`),
      ],
      [
        "a pre-release naming a commit off this source's line of main, on next",
        registry(["2.1.0", main.unrelated], { latest: "2.1.0", next: main.unrelated }),
        goes(
          `${main.unrelated} names ${sha7(main.unrelated)}, which is neither an ancestor nor a descendant of ${source7} on main; ignored`,
        ),
      ],
      [
        "a hand-published version this pipeline never minted, which no dist-tag names",
        registry(["2.1.0", "2.1.1-beta.1"], { latest: "2.1.0" }),
        goes(),
      ],
    ];
    for (const [name, packument, expected] of cases) {
      expect({ name, ...nextPublishVerdict(fx.work, fx.mergeSha, main.own, packument) }).toEqual({
        name,
        ...expected,
      });
    }
    // A checkout git cannot read is not a checkout without the commit: the same record that skipped above stops
    // the guard from a directory that is no repository, instead of publishing over the descendant.
    const nowhere = join(fx.root, "not-a-repository");
    mkdirSync(nowhere);
    expect(() =>
      nextPublishVerdict(
        nowhere,
        fx.mergeSha,
        main.own,
        registry(["2.1.0", main.descendant], { latest: "2.1.0", next: main.descendant }),
      ),
    ).toThrow(
      /^git rev-parse --verify --quiet [0-9a-f]{7}\^\{commit\} failed: fatal: not a git repository/,
    );
    // The subcommand prints the skip as one stdout line, the notice the workflow raises.
    const judge = checkoutOf(fx, "stale-judge", fx.mergeSha, "packaged-bundle-bytes-4\n");
    return withRegistry(
      {
        status: 200,
        body: registry(["2.1.0", main.descendant], { latest: "2.1.0", next: main.descendant }),
      },
      async (url) => {
        expect(
          await subcommand(
            judge,
            { GITHUB_SHA: fx.mergeSha, NPM_REGISTRY_URL: url },
            "npm-verdict",
            "next",
          ),
        ).toEqual({
          stdout: `skip ${staleReason(main.descendant)}\n`,
          stderr: "",
          status: 0,
        });
      },
    );
  });

  const stableVerdicts: [string, string, Packument | null, PublishVerdict][] = [
    ["a package the registry has never seen", "2.1.0", null, { publish: true, version: "2.1.0" }],
    [
      "the release after the bootstrap pre-release",
      "2.1.0",
      registry(["2.0.1-main.0.g0000000"], {
        latest: "2.0.1-main.0.g0000000",
        next: "2.0.1-main.0.g0000000",
      }),
      { publish: true, version: "2.1.0" },
    ],
    [
      "a newer release",
      "2.1.0",
      registry(["2.0.0", "2.0.1-main.412.20260901.g1111111"], {
        latest: "2.0.0",
        next: "2.0.1-main.412.20260901.g1111111",
      }),
      { publish: true, version: "2.1.0" },
    ],
    [
      "a rerun of the release's job",
      "2.1.0",
      registry(["2.0.0", "2.1.0"], { latest: "2.1.0" }),
      {
        publish: false,
        version: "2.1.0",
        reason: "2.1.0 is already on the registry",
      },
    ],
    [
      "a release taking latest over from a bootstrap pre-release that sorts above it",
      "2.1.0",
      registry(["2.1.1-main.0.g0000000"], {
        latest: "2.1.1-main.0.g0000000",
        next: "2.1.1-main.0.g0000000",
      }),
      { publish: true, version: "2.1.0" },
    ],
    [
      "a rerun of an older release's job after a newer release",
      "2.1.0",
      registry(["2.0.0", "2.2.0"], { latest: "2.2.0" }),
      {
        publish: false,
        version: "2.1.0",
        reason:
          "the registry's latest is 2.2.0, newer than 2.1.0, so this rerun of an older release publishes nothing (npm publish would move latest back)",
      },
    ],
  ];
  test.each(stableVerdicts)("stable: %s", (_name, version, packument, expected) => {
    expect(stablePublishVerdict(version, packument)).toEqual(expected);
  });

  test("stable: a built package.json that is not the tag's version stops before the registry is asked", async () => {
    const fx = seedFixture();
    const asked = await withRegistry({ status: 404 }, async (registry, requests) => {
      await expect(
        npmVerdict({
          cwd: fx.work,
          channel: "stable",
          sourceSha: fx.mergeSha,
          tag: "v2.2.0",
          registry,
        }),
      ).rejects.toThrow(
        "package.json at the release source is version 2.1.0, but the release tag is v2.2.0; refusing to publish a version this source did not release.",
      );
      return requests;
    });
    expect(asked).toEqual([]);
  });

  type Answer = { status: number; body?: unknown };
  /** A registry for the fixture's package on a local port: one answer, or a sequence served in order with its last
   * answer repeated. Each request is recorded as its path and query. */
  function withRegistry<T>(
    answers: Answer | Answer[],
    body: (url: string, requests: string[]) => Promise<T>,
  ): Promise<T> {
    const sequence = Array.isArray(answers) ? answers : [answers];
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname, search } = new URL(request.url);
        requests.push(pathname + search);
        const answer = sequence[Math.min(requests.length, sequence.length) - 1] as Answer;
        return answer.body === undefined
          ? new Response("", { status: answer.status })
          : Response.json(answer.body, { status: answer.status });
      },
    });
    return body(`http://127.0.0.1:${server.port}`, requests).finally(() => server.stop(true));
  }

  /** The fixture's registry record holding both channels' versions, the run's own next version included. */
  const holding = (own: string): Answer => ({
    status: 200,
    body: {
      versions: { "2.1.0": {}, "2.2.0": {}, [own]: {} },
      "dist-tags": { latest: "2.2.0", next: own },
    },
  });

  test.each<
    [
      label: string,
      options: { channel: "next" } | { channel: "stable"; tag: string },
      answer: (own: string) => Answer,
      expected: (own: string) => NextVerdict | PublishVerdict,
    ]
  >([
    [
      "404 is an unpublished package",
      { channel: "next" },
      () => ({ status: 404 }),
      (own) => ({ publish: true, version: own, notices: [] }),
    ],
    [
      "a stable version the record holds is skipped",
      { channel: "stable", tag: "v2.1.0" },
      holding,
      () => ({ publish: false, version: "2.1.0", reason: "2.1.0 is already on the registry" }),
    ],
    [
      "a next version the record holds is skipped",
      { channel: "next" },
      holding,
      (own) => ({
        publish: false,
        version: own,
        reason: `${own} is already on the registry`,
        notices: [],
      }),
    ],
  ])(
    "the verdict reads the registry's record of the package named in package.json past the CDN cache: %s",
    async (_label, options, answer, expected) => {
      const fx = seedFixture();
      const own = versionOf(fx.work, fx.mergeSha, 2);
      const verdict = await withRegistry(answer(own), async (registry, requests) => {
        const result = await npmVerdict({
          cwd: fx.work,
          sourceSha: fx.mergeSha,
          registry,
          ...options,
        });
        return { result, requests };
      });
      expect(verdict.result).toEqual(expected(own));
      // A query string no earlier request carried: the CDN caches a packument by URL for up to 300 s and misses on it.
      expect(verdict.requests).toEqual([
        expect.stringMatching(/^\/@scope%2Fpkg\?fresh=\d+-[0-9a-z]+$/),
      ]);
    },
  );

  const malformed: [string, unknown, RegExp | string][] = [
    ["an empty object", {}, "is not a packument (an object with versions and dist-tags records)"],
    ["an array", [], /is not a packument/],
    ["versions as a list", { versions: ["2.1.0"], "dist-tags": {} }, /is not a packument/],
    [
      "a dist-tag naming a non-string",
      { versions: {}, "dist-tags": { latest: 210 } },
      /names dist-tag latest as 210, not a version/,
    ],
  ];
  test.each(malformed)(
    "a 200 body that is %s stops the verdict, not an empty registry",
    async (_name, body, error) => {
      const fx = seedFixture();
      await withRegistry({ status: 200, body }, async (registry) => {
        await expect(
          npmVerdict({
            cwd: fx.work,
            channel: "stable",
            sourceSha: fx.mergeSha,
            tag: "v2.1.0",
            registry,
          }),
        ).rejects.toThrow(error);
      });
    },
  );

  test("a registry that answers anything but 200 or 404 stops the verdict instead of publishing blind", async () => {
    const fx = seedFixture();
    await withRegistry({ status: 503 }, async (registry) => {
      await expect(
        npmVerdict({
          cwd: fx.work,
          channel: "stable",
          sourceSha: fx.mergeSha,
          tag: "v2.1.0",
          registry,
        }),
      ).rejects.toThrow(
        `the registry answered 503 for @scope/pkg (${registry}/@scope%2Fpkg); refusing to publish without knowing what it holds.`,
      );
    });
  });

  test("the npm-verdict subcommand prints publish or skip alone on stdout, its notices on stderr, and the channel is required", async () => {
    const fx = seedFixture();
    const own = versionOf(fx.work, fx.mergeSha, 2);
    await withRegistry({ status: 404 }, async (registry) => {
      expect(
        await subcommand(
          fx.work,
          { GITHUB_SHA: fx.mergeSha, NPM_REGISTRY_URL: registry },
          "npm-verdict",
          "next",
        ),
      ).toEqual({ stdout: `publish ${own}\n`, stderr: "", status: 0 });
      expect(
        await subcommand(
          fx.work,
          { GITHUB_SHA: fx.mergeSha, TAG: "v2.1.0", NPM_REGISTRY_URL: registry },
          "npm-verdict",
          "stable",
        ),
      ).toEqual({ stdout: "publish 2.1.0\n", stderr: "", status: 0 });
    });
    const unresolved = "2.1.1-main.9.20260901.g0000000";
    await withRegistry(
      {
        status: 200,
        body: registry(["2.1.0", unresolved], { latest: "2.1.0", next: unresolved }),
      },
      async (url) => {
        expect(
          await subcommand(
            fx.work,
            { GITHUB_SHA: fx.mergeSha, NPM_REGISTRY_URL: url },
            "npm-verdict",
            "next",
          ),
        ).toEqual({
          stdout: `publish ${own}\n`,
          stderr: `${unresolved} names 0000000, which is no commit in this checkout; ignored\n`,
          status: 0,
        });
      },
    );
    await withRegistry(
      { status: 200, body: { versions: { "2.1.0": {} }, "dist-tags": { latest: "2.1.0" } } },
      async (registry) => {
        expect(
          await subcommand(
            fx.work,
            { GITHUB_SHA: fx.mergeSha, TAG: "v2.1.0", NPM_REGISTRY_URL: registry },
            "npm-verdict",
            "stable",
          ),
        ).toEqual({ stdout: "skip 2.1.0 is already on the registry\n", stderr: "", status: 0 });
      },
    );
    expect(await subcommand(fx.work, { GITHUB_SHA: fx.mergeSha }, "npm-verdict")).toEqual({
      stdout: "",
      stderr:
        "release-pipeline npm-verdict: npm-verdict takes the channel, next or stable, not null\n",
      status: 1,
    });
  });

  describe("npm-confirm after a next publish", () => {
    /** The fixture's published version, and an ancestor's pre-release next named before it. */
    const published = (fx: Fixture) => versionOf(fx.work, fx.mergeSha, 2);
    const older = (fx: Fixture) => versionOf(fx.work, fx.seedSha, 1);
    /** A descendant's pre-release: main grew one commit past the source, fetched into the work clone. */
    function newer(fx: Fixture): string {
      const after = pushGreenCommit(fx, "after", "packaged-bundle-bytes-2\n");
      git(fx.work, "fetch", "--quiet", "origin");
      return versionOf(fx.work, after.sha, 3);
    }
    const confirm = (fx: Fixture, registry: string, attempts = 5) =>
      npmConfirm({ cwd: fx.work, sourceSha: fx.mergeSha, registry, attempts, delayMs: 0 });
    /** The drift the confirmation reports when next stayed on this run's version while a descendant's is on the record. */
    const behind = (fx: Fixture, ahead: string): string =>
      `the registry's next is ${published(fx)} while it holds ${ahead}, whose source ${ahead.slice(-7)} is a descendant ` +
      `of ${fx.mergeSha.slice(0, 7)} on main; this stale run moved next back, and the next release-PR refresh moves it forward ` +
      `(npm dist-tag add @scope/pkg@${ahead} next repairs it by hand)`;

    test("a record that lags the publish is read again until it shows the version, each read past the CDN cache", async () => {
      const fx = seedFixture();
      const lagging = registry(["2.1.0", older(fx)], { latest: "2.1.0", next: older(fx) });
      const caughtUp = registry(["2.1.0", older(fx), published(fx)], {
        latest: "2.1.0",
        next: published(fx),
      });
      const result = await withRegistry(
        [
          { status: 200, body: lagging },
          { status: 200, body: lagging },
          { status: 200, body: caughtUp },
        ],
        async (url, requests) => ({ verdict: await confirm(fx, url), requests }),
      );
      expect(result.verdict).toEqual({ outcome: "settled", version: published(fx), reads: 3 });
      expect(result.requests).toHaveLength(3);
      expect(new Set(result.requests).size).toBe(3);
    });

    test("the reads stop at the bound while the record still lacks the version, whether it lags or is 404", async () => {
      const fx = seedFixture();
      const lagging = registry(["2.1.0", older(fx)], { latest: "2.1.0", next: older(fx) });
      const unsettled = {
        outcome: "unsettled" as const,
        version: published(fx),
        reason: `the registry's record still lacks ${published(fx)} after 3 reads over 0 s; a run judged before it shows may move next back, and the release-PR refresh after it moves next forward`,
      };
      const lagged = await withRegistry({ status: 200, body: lagging }, async (url, requests) => ({
        verdict: await confirm(fx, url, 3),
        requests,
      }));
      expect(lagged.verdict).toEqual(unsettled);
      expect(lagged.requests).toHaveLength(3);
      const missing = await withRegistry({ status: 404 }, async (url, requests) => ({
        verdict: await confirm(fx, url, 3),
        requests,
      }));
      expect(missing.verdict).toEqual(unsettled);
      expect(missing.requests).toHaveLength(3);
    });

    test("next behind a descendant's pre-release the record holds is reported, never moved", async () => {
      const fx = seedFixture();
      const ahead = newer(fx);
      const drifted = registry(["2.1.0", older(fx), ahead, published(fx)], {
        latest: "2.1.0",
        next: published(fx),
      });
      await withRegistry({ status: 200, body: drifted }, async (url) => {
        expect(await confirm(fx, url)).toEqual({
          outcome: "behind",
          version: published(fx),
          reason: behind(fx, ahead),
        });
      });
    });

    test("next already on a descendant's pre-release is no drift: a later run moved it forward past this one", async () => {
      const fx = seedFixture();
      const ahead = newer(fx);
      const overtaken = registry(["2.1.0", published(fx), ahead], {
        latest: "2.1.0",
        next: ahead,
      });
      await withRegistry({ status: 200, body: overtaken }, async (url) => {
        expect(await confirm(fx, url)).toEqual({
          outcome: "settled",
          version: published(fx),
          reads: 1,
        });
      });
    });

    test("a newer release the record holds is not a drift: next sits below latest until the next release-PR refresh", async () => {
      const fx = seedFixture();
      const released = registry(["2.1.0", published(fx), "2.2.0"], {
        latest: "2.2.0",
        next: published(fx),
      });
      await withRegistry({ status: 200, body: released }, async (url) => {
        expect(await confirm(fx, url)).toEqual({
          outcome: "settled",
          version: published(fx),
          reads: 1,
        });
      });
    });

    test("a read the registry fails is a read that did not show the version: the lane is held through the budget", async () => {
      const fx = seedFixture();
      const caughtUp = registry(["2.1.0", published(fx)], { latest: "2.1.0", next: published(fx) });
      const recovered = await withRegistry(
        [{ status: 503 }, { status: 503 }, { status: 200, body: caughtUp }],
        async (url, requests) => ({ verdict: await confirm(fx, url), requests }),
      );
      expect(recovered.verdict).toEqual({ outcome: "settled", version: published(fx), reads: 3 });
      expect(recovered.requests).toHaveLength(3);
    });

    test("a registry that answers anything but 200 or 404 on every read stops the confirmation after the budget", async () => {
      const fx = seedFixture();
      const requests = await withRegistry({ status: 503 }, async (url, requests) => {
        await expect(confirm(fx, url, 3)).rejects.toThrow(
          `the registry answered 503 for @scope/pkg (${url}/@scope%2Fpkg); refusing to publish without knowing what it holds.`,
        );
        return requests;
      });
      expect(requests).toHaveLength(3);
      await expect(
        npmConfirm({
          cwd: fx.work,
          sourceSha: fx.mergeSha,
          registry: "http://127.0.0.1:9",
          attempts: 0,
          delayMs: 0,
        }),
      ).rejects.toThrow("the read attempts must be a positive integer, not 0");
    });

    test("the npm-confirm subcommand prints settled, unsettled, or behind on stdout, counts its reads, and takes the next channel alone", async () => {
      const fx = seedFixture();
      const ahead = newer(fx);
      const lagging = registry(["2.1.0", older(fx)], { latest: "2.1.0", next: older(fx) });
      const converged = registry(["2.1.0", published(fx)], {
        latest: "2.1.0",
        next: published(fx),
      });
      const drifted = registry(["2.1.0", ahead, published(fx)], {
        latest: "2.1.0",
        next: published(fx),
      });
      const env = (url: string, pause?: string) => ({
        GITHUB_SHA: fx.mergeSha,
        NPM_REGISTRY_URL: url,
        NPM_CONFIRM_PAUSE_MS: pause,
      });
      const settled = (reads: string) =>
        `settled ${published(fx)} is on the registry after ${reads}; next is not behind a descendant's pre-release\n`;
      await withRegistry({ status: 200, body: converged }, async (url) => {
        expect(await subcommand(fx.work, env(url), "npm-confirm", "next")).toEqual({
          stdout: settled("1 read"),
          stderr: "",
          status: 0,
        });
      });
      // The bound is the control: a run that ignored the variable would pause 20 s between its two reads.
      await withRegistry(
        [
          { status: 200, body: lagging },
          { status: 200, body: converged },
        ],
        async (url) => {
          const started = performance.now();
          expect(await subcommand(fx.work, env(url, "0"), "npm-confirm", "next")).toEqual({
            stdout: settled("2 reads"),
            stderr: "",
            status: 0,
          });
          expect(performance.now() - started).toBeLessThan(10_000);
        },
      );
      await withRegistry({ status: 200, body: drifted }, async (url) => {
        expect(await subcommand(fx.work, env(url), "npm-confirm", "next")).toEqual({
          stdout: `behind ${behind(fx, ahead)}\n`,
          stderr: "",
          status: 0,
        });
      });
      expect(await subcommand(fx.work, env("http://127.0.0.1:9"), "npm-confirm", "stable")).toEqual(
        {
          stdout: "",
          stderr:
            'release-pipeline npm-confirm: npm-confirm takes the channel, next, not "stable"\n',
          status: 1,
        },
      );
      expect(
        await subcommand(fx.work, env("http://127.0.0.1:9", "soon"), "npm-confirm", "next"),
      ).toEqual({
        stdout: "",
        stderr:
          'release-pipeline npm-confirm: NPM_CONFIRM_PAUSE_MS must be a whole number of milliseconds, not "soon"\n',
        status: 1,
      });
    });
  });
});
