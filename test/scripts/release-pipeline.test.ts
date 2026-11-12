/**
 * The release pipeline against local fixture repositories (a bare origin plus clones playing the CI checkouts), so the tag topology is a unit test
 * rather than what the first real release discovers.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  anchorCheck,
  anchorReleasePr,
  boundaryCheck,
} from "../../.github/scripts/release-pipeline/anchor.js";
import {
  FROZEN,
  packageCommit,
  packageRelease,
  retagMajor,
} from "../../.github/scripts/release-pipeline/tags.js";
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
import { runStep } from "./step-fixture.js";

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
    // The shape release-please mints with include-component-in-tag on; the config keeps it off, and the hook refuses it either way.
    ["github-settings-as-code-v2.1.0", /not a vX\.Y\.Z release tag/],
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
  const unbuilt = ["lib/index.js", "lib/settings.schema.json", "lib/pkg/index.js"].flatMap(
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
      /pending changes beyond lib\/index\.js, lib\/settings\.schema\.json, and lib\/pkg\//,
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
      /is not [0-9a-f]{40} plus lib\/index\.js, lib\/settings\.schema\.json, and lib\/pkg\/, minus package\.json's preparation scripts, alone/,
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

/** release-please's PR branch: manifest and changelog bumped to `version` on `from`, the notes linking the commits `listed` as release-please
 * links them (none: one entry with a short sha, which names no commit); left unpushed for a competitor plan when `push` is false. */
function createReleasePrBranch(
  fx: Fixture,
  from: string,
  version: string,
  push = true,
  listed: string[] = [],
): { dir: string; sha: string } {
  const dir = clone(fx.root, fx.origin, `rp-branch-${version}-${from.slice(0, 7)}`);
  git(dir, "checkout", "--quiet", "-B", "release-please--branches--main", from);
  write(dir, ".release-please-manifest.json", `${JSON.stringify({ ".": version }, null, 2)}\n`);
  const links = listed.length === 0 ? ["abc1234"] : listed;
  const entries = links.map(
    (sha) => `* the fix ([${sha.slice(0, 7)}](https://example.invalid/commit/${sha}))\n`,
  );
  write(
    dir,
    "CHANGELOG.md",
    `# Changelog\n\n## [${version}](https://example.invalid/compare) (2026-08-14)\n\n### Bug Fixes\n\n${entries.join("")}${CHANGELOG_21}`,
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

/** release-please's branch for main's release PR. */
const RELEASE_BRANCH = "release-please--branches--main";

/** The boundary the seed fixture's config records: no commit. */
const PLACEHOLDER = "0".repeat(40);

/** What every refusal of an unreadable release PR branch ends with: the repair, its command on a line of its own. */
const REBUILD =
  "Delete the branch, and the next green push to main has release-please rebuild the release PR and the hook anchor it:\n" +
  "  git push origin --delete release-please--branches--main";

/** The fixture's release-please config recording `boundary`, or no boundary. */
function configRecording(boundary?: string): string {
  const recorded = boundary === undefined ? {} : { "last-release-sha": boundary };
  const packages = { ".": { "release-type": "simple", draft: true } };
  return `${JSON.stringify({ ...recorded, packages }, null, 2)}\n`;
}

/** A commit of `subject` on origin's main, as a merged PR lands one. */
function landOnMain(fx: Fixture, name: string, subject: string): string {
  const dir = clone(fx.root, fx.origin, name);
  write(dir, `docs/${name}.md`, `${subject}\n`);
  const sha = commitAll(dir, subject);
  git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  return sha;
}

/** GitHub's "Update branch": origin's main merged into the release PR branch as the second parent. */
function updateReleasePrBranch(fx: Fixture, name: string): void {
  const dir = clone(fx.root, fx.origin, name);
  git(dir, "checkout", "--quiet", RELEASE_BRANCH);
  const subject = `Merge branch 'main' into ${RELEASE_BRANCH}`;
  git(dir, "merge", "--quiet", "--no-ff", "-m", subject, "origin/main");
  git(dir, "push", "--quiet", "origin", `HEAD:refs/heads/${RELEASE_BRANCH}`);
}

/** GitHub's "Update with rebase": the release PR branch replayed onto origin's main, so release-please's commit sits on main's tip. */
function rebaseReleasePrBranch(fx: Fixture, name: string): void {
  const dir = clone(fx.root, fx.origin, name);
  git(dir, "checkout", "--quiet", RELEASE_BRANCH);
  git(dir, "rebase", "--quiet", "origin/main");
  git(dir, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${RELEASE_BRANCH}`);
}

/** A commit on the release PR branch that sets last-release-sha to `boundary`: an anchor made by hand. */
function anchorByHand(fx: Fixture, name: string, boundary: string): void {
  const dir = clone(fx.root, fx.origin, name);
  git(dir, "checkout", "--quiet", RELEASE_BRANCH);
  write(dir, "release-please-config.json", configRecording(boundary));
  commitAll(dir, "chore: anchor by hand");
  git(dir, "push", "--quiet", "origin", `HEAD:refs/heads/${RELEASE_BRANCH}`);
}

/** The release PR's head with its full history, detached: the checkout the anchor-check job makes. */
function releasePrHead(fx: Fixture, name: string): string {
  const dir = clone(fx.root, fx.origin, name);
  git(dir, "checkout", "--quiet", "--detach", `origin/${RELEASE_BRANCH}`);
  return dir;
}

/** The release PR squash-merged onto origin's main, as GitHub lands it; a checkout of main at the merge. */
function squashMergeReleasePr(fx: Fixture, name: string, version: string): string {
  const dir = clone(fx.root, fx.origin, name);
  git(dir, "merge", "--quiet", "--squash", `origin/${RELEASE_BRANCH}`);
  git(dir, "commit", "--quiet", "-m", `chore(main): release ${version} (#60)`);
  git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  return dir;
}

interface AnchoredPr {
  /** A changelog-visible commit of the open cycle, older than `base`. */
  early: string;

  /** The main commit release-please built the branch on. */
  base: string;
}

/** A release PR as a green run leaves one: two changelog-visible commits past the 2.1.0 merge, release-please's
 * branch built on the second, and the hook's anchor on it. */
function anchoredReleasePr(fx: Fixture): AnchoredPr {
  const early = pushGreenCommit(fx, "early", "bundle-early\n").sha;
  const base = pushGreenCommit(fx, "notes-base", "bundle-base\n").sha;
  createReleasePrBranch(fx, base, "2.2.0");
  const hook = clone(fx.root, fx.origin, "hook");
  expect(anchorReleasePr({ cwd: hook, sourceSha: base }).changed).toBe(true);
  return { early, base };
}

/** What `run` refuses with: its message, whole. */
function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "no refusal";
}

/** The start of every refusal of a release PR's anchor: the value the branch records. */
const recording = (recorded: string): string =>
  `last-release-sha in release-please-config.json is ${JSON.stringify(recorded)}`;

/** anchor-check's refusal of a release PR built on `base` whose anchor the stamp at `base` repairs: none on the branch, or another commit. */
function notAnchored(state: "missing" | "edited", recorded: string, base: string): Error {
  const cause = {
    missing: "the branch carries no anchor commit",
    edited: "the anchor names another commit",
  };
  return new Error(
    [
      `${recording(recorded)}, but release-please built this release PR on ${base}: ${cause[state]}.`,
      "Stamp it from a clean checkout; the command leaves HEAD detached on the release PR branch, and its push re-runs the checks:",
      `  GITHUB_SHA=${base} bun .github/scripts/release-pipeline.ts anchor`,
      'If it answers "already anchored", close and reopen the PR to run the checks on its head.',
    ].join("\n"),
  );
}

/** The refusal, by the check and by the command alike, of a release PR whose anchor is older than the `base` it is built on: no stamp, the rebuild alone. */
function movedAfterAnchoring(recorded: string, base: string): Error {
  return new Error(
    [
      `${recording(recorded)}, an older commit than ${base}, which this release PR is built on.`,
      "The branch moved after it was anchored, or the anchor was edited: the notes may lack the commits between the two, so no stamp is offered.",
      REBUILD,
    ].join("\n"),
  );
}

/** The refusal of a release PR branch with no release commit on its first-parent chain above `main`. */
function noReleaseCommit(main: string): Error {
  return new Error(
    [
      `the release PR branch holds no release commit ("chore(main): release X.Y.Z") on its first-parent chain above ${main}.`,
      "The commit its notes were built from cannot be read: main was merged in with the branch as the second parent, or release-please did not build this branch.",
      REBUILD,
    ].join("\n"),
  );
}

/** boundary-check's refusal of a boundary outside the cycle `merge` closed; `repair` is the value to set, or how to find it. */
function outsideCycle(recorded: string | undefined, merge: string, repair: string): Error {
  return new Error(
    `last-release-sha in release-please-config.json is ${JSON.stringify(recorded)}, outside the cycle the newest release merge ${merge} closed: ` +
      `an anchor was lost, or the value was edited.\nFix by PR: set last-release-sha to ${repair}`,
  );
}

describe("anchorReleasePr", () => {
  test("the boundary lands inside the release PR branch and merges onto main", () => {
    const fx = seedFixture();
    // The platform's release job proposes on every green push but a release merge's own, so no release PR is built on the merge itself.
    const mainHead = pushGreenCommit(fx, "notes-base", "bundle-base\n").sha;
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

  test("a hidden-type commit landing on main between the refresh and the hook job leaves the hook anchoring the commit the branch is built on", () => {
    const fx = seedFixture();
    createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
    // Depth 1 at the run's commit, as the hook job checks out, before main moves on.
    const worker = shallowClone(fx, "anchor-late");
    landOnMain(fx, "hidden", "docs: land after the refresh, before the hook job");
    expect(anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha })).toEqual({
      changed: true,
      reason: `release-please--branches--main: anchored at ${fx.mergeSha}`,
    });
    expect(releasePrConfig(fx, "anchor-late-check").boundary).toBe(fx.mergeSha);
  });

  test.each<[string, (fx: Fixture) => { run: string; builtOn: string }]>([
    [
      "an older commit than this run's",
      (fx) => {
        createReleasePrBranch(fx, fx.seedSha, "2.2.0");
        return { run: fx.mergeSha, builtOn: fx.seedSha };
      },
    ],
    [
      "a newer commit than this run's, by a newer run's refresh",
      (fx) => {
        createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
        const newer = pushGreenCommit(fx, "newer", "bundle-newer\n").sha;
        createReleasePrBranch(fx, newer, "2.2.0");
        return { run: fx.mergeSha, builtOn: newer };
      },
    ],
    [
      "an older commit, with this run's commit merged in by Update branch",
      (fx) => {
        createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
        const tip = landOnMain(fx, "hidden", "docs: land after the refresh");
        updateReleasePrBranch(fx, "update-branch");
        return { run: tip, builtOn: fx.mergeSha };
      },
    ],
  ])("a release PR branch built on %s is left unstamped", (_name, build) => {
    const fx = seedFixture();
    const { run, builtOn } = build(fx);
    const before = git(fx.origin, "rev-parse", `refs/heads/${RELEASE_BRANCH}`);
    const worker = clone(fx.root, fx.origin, "anchor-other-base");
    expect(anchorReleasePr({ cwd: worker, sourceSha: run })).toEqual({
      changed: false,
      reason: `the release PR branch is built on ${builtOn}, not on ${run}; the anchor is the commit the branch is built on, so nothing is stamped`,
    });
    expect(git(fx.origin, "rev-parse", `refs/heads/${RELEASE_BRANCH}`)).toBe(before);
  });

  test("a branch with no release commit above the run's commit is refused naming the shape", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "not-release-please");
    write(dir, "src/marker.ts", "export const marker = 5;\n");
    commitAll(dir, "chore: not a release commit");
    git(dir, "push", "--quiet", "origin", `HEAD:refs/heads/${RELEASE_BRANCH}`);
    const worker = clone(fx.root, fx.origin, "anchor-no-release");
    expect(() => anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha })).toThrow(
      noReleaseCommit(fx.mergeSha),
    );
  });

  test("a checkout with uncommitted changes to tracked files is refused before the branch is checked out over them", () => {
    const fx = seedFixture();
    createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
    const work = "export const marker = 'uncommitted work';\n";
    const dirty = clone(fx.root, fx.origin, "operator-dirty");
    write(dirty, "src/marker.ts", work);
    expect(() => anchorReleasePr({ cwd: dirty, sourceSha: fx.mergeSha })).toThrow(
      new Error(
        "this checkout has uncommitted changes to tracked files (M src/marker.ts), and anchoring checks the release PR branch out.\n" +
          "Run the command from a clean checkout: commit the changes first, or use another clone.",
      ),
    );
    expect(readFileSync(join(dirty, "src/marker.ts"), "utf8")).toBe(work);
    expect(git(dirty, "symbolic-ref", "--short", "HEAD")).toBe("main");
    // The control: the same command from a clean checkout anchors, and leaves HEAD detached as its repair text says.
    const clean = clone(fx.root, fx.origin, "operator-clean");
    expect(anchorReleasePr({ cwd: clean, sourceSha: fx.mergeSha }).changed).toBe(true);
    expect(git(clean, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(releasePrConfig(fx, "operator-check").boundary).toBe(fx.mergeSha);
  });

  test.each<[string, string]>([
    ["untracked", ""],
    ["untracked and ignored by the clone's exclude file", "docs/guide.md\n"],
  ])(
    "the operator's own file at a path the release PR branch tracks, %s, survives: git refuses the checkout, and nothing is pushed",
    (_name, excluded) => {
      const fx = seedFixture();
      // The operator's clone predates a file main gained since, and holds a file of their own at its path.
      const operator = clone(fx.root, fx.origin, "operator-untracked");
      const base = landOnMain(fx, "guide", "docs: add a guide");
      const branch = createReleasePrBranch(fx, base, "2.2.0");
      const work = "the operator's own notes, in no commit\n";
      write(operator, "docs/guide.md", work);
      write(operator, ".git/info/exclude", excluded);
      expect(() => anchorReleasePr({ cwd: operator, sourceSha: base })).toThrow(
        /^git checkout --quiet --detach --no-overwrite-ignore FETCH_HEAD failed: [\s\S]*docs\/guide\.md/,
      );
      expect({
        file: readFileSync(join(operator, "docs/guide.md"), "utf8"),
        head: git(operator, "symbolic-ref", "--short", "HEAD"),
        branch: git(fx.origin, "rev-parse", `refs/heads/${RELEASE_BRANCH}`),
      }).toEqual({ file: work, head: "main", branch: branch.sha });
    },
  );

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
          new Error(
            "could not anchor release-please--branches--main after 3 attempts: something keeps rewriting the branch.\n" +
              "Rerun this job once the branch settles.",
          ),
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

  test("a release PR merged with hidden-type commits between its anchor and the merge lands a boundary inside the cycle the merge closed", () => {
    const fx = seedFixture();
    const { base } = anchoredReleasePr(fx);
    landOnMain(fx, "hidden-1", "docs: land after the release PR was anchored");
    landOnMain(fx, "hidden-2", "chore: land after it too");
    updateReleasePrBranch(fx, "update-branch");
    expect(boundaryCheck(squashMergeReleasePr(fx, "main-after", "2.2.0")).boundary).toBe(base);
  });

  test.each<[string, (fx: Fixture) => string]>([
    ["the previous release merge's parent", (fx) => fx.seedSha],
    ["the previous release merge itself", (fx) => fx.mergeSha],
  ])(
    "a lost anchor leaves the previous cycle's boundary, %s, on main and is refused naming the newest commit the release's notes list, which keeps a visible commit the notes lack for the next cycle",
    (_name, previousBoundary) => {
      const fx = seedFixture();
      const previous = previousBoundary(fx);
      const align = clone(fx.root, fx.origin, "align");
      write(align, "release-please-config.json", configRecording(previous));
      commitAll(align, "chore: record the boundary the 2.1.0 release landed");
      git(align, "push", "--quiet", "origin", "HEAD:refs/heads/main");
      // The release PR is never anchored, so its merge carries main's own value; a visible commit lands after its notes were built.
      const listed = pushGreenCommit(fx, "listed", "bundle-listed\n").sha;
      createReleasePrBranch(fx, listed, "2.2.0", true, [listed]);
      const unlisted = pushGreenCommit(fx, "unlisted", "bundle-unlisted\n").sha;
      const main = squashMergeReleasePr(fx, "main-after", "2.2.0");
      const merge = git(main, "rev-parse", "HEAD");
      /** What the next cycle reads from main with `boundary` recorded: the commits after it. */
      const nextCycle = (boundary: string): string[] =>
        git(main, "rev-list", `${boundary}..${merge}`).split("\n");

      const refused = refusalOf(() => boundaryCheck(main));
      expect(refused).toContain(`set last-release-sha to ${listed},`);
      expect(refused).toBe(
        outsideCycle(previous, merge, `${listed}, the newest commit release 2.2.0's notes list.`)
          .message,
      );
      write(main, "release-please-config.json", configRecording(listed));
      commitAll(main, "fix(release): restore the boundary");
      expect(boundaryCheck(main).boundary).toBe(listed);
      expect(nextCycle(listed)).toContain(unlisted);
      // The control: the merge's parent passes the check too, and no cycle would ever list the commit.
      expect(git(main, "rev-parse", `${merge}^`)).toBe(unlisted);
      write(main, "release-please-config.json", configRecording(unlisted));
      commitAll(main, "fix(release): record the merge's parent instead");
      expect(boundaryCheck(main).boundary).toBe(unlisted);
      expect(nextCycle(unlisted)).not.toContain(unlisted);
    },
  );

  test.each<[string, (fx: Fixture) => { main: string; version: string }]>([
    [
      "link no commit by its full sha",
      // The seed fixture: its config records a placeholder, and its 2.1.0 notes link a short sha.
      (fx) => ({ main: fx.work, version: "2.1.0" }),
    ],
    [
      "link only a commit of an older cycle",
      (fx) => {
        const base = pushGreenCommit(fx, "notes-base", "bundle-base\n").sha;
        createReleasePrBranch(fx, base, "2.2.0", true, [fx.seedSha]);
        return { main: squashMergeReleasePr(fx, "main-after", "2.2.0"), version: "2.2.0" };
      },
    ],
  ])(
    "a lost anchor whose release notes %s is refused naming no sha, and where to read the notes",
    (_name, build) => {
      const fx = seedFixture();
      const { main, version } = build(fx);
      const merge = git(main, "rev-parse", "HEAD");
      expect(() => boundaryCheck(main)).toThrow(
        outsideCycle(
          PLACEHOLDER,
          merge,
          `the newest commit release ${version}'s notes list; none could be read here, so find it in:\n  git show ${merge} -- CHANGELOG.md`,
        ),
      );
    },
  );

  test("the first release merge on a history closes a cycle that reaches back to the root, and an absent boundary beside it is still refused", () => {
    const fx = seedFixture();
    const dir = clone(fx.root, fx.origin, "boundary-first");
    git(dir, "checkout", "--quiet", fx.seedSha);
    write(dir, "src/marker.ts", "export const marker = 2;\n");
    const base = commitAll(dir, "feat: the commit the first release's notes were built from");
    write(dir, "docs/hidden.md", "landed before the merge\n");
    commitAll(dir, "docs: land before the first release merge");
    write(dir, "release-please-config.json", configRecording(base));
    write(
      dir,
      "CHANGELOG.md",
      `# Changelog\n\n## 2.1.0\n\n* the first ([${base.slice(0, 7)}](https://example.invalid/commit/${base}))\n`,
    );
    const merge = commitAll(dir, "chore(main): release 2.1.0 (#42)");
    expect(boundaryCheck(dir).boundary).toBe(base);
    write(dir, "release-please-config.json", configRecording());
    commitAll(dir, "chore: drop the boundary");
    expect(() => boundaryCheck(dir)).toThrow(
      outsideCycle(undefined, merge, `${base}, the newest commit release 2.1.0's notes list.`),
    );
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
    expect(() => boundaryCheck(dir)).toThrow(
      new Error(
        `last-release-sha in release-please-config.json is "${PLACEHOLDER}", but no release merge is reachable from HEAD.\n` +
          "That commit is not on this history at all: this is not main, or the boundary never landed.\n" +
          "Fix by PR when it never landed: remove last-release-sha, which a history with no release merge does not record.",
      ),
    );
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
    expect(refusalOf(() => boundaryCheck(dir)).split("\n")).toEqual([
      `last-release-sha in release-please-config.json is "${fx.seedSha}", but no release merge is reachable from HEAD.`,
      expect.stringMatching(
        /^This history holds that commit, so release-please's merge subject no longer matches \/.+\/\.$/,
      ),
      "Investigate RELEASE_SUBJECT in .github/scripts/release-pipeline/anchor.ts.",
    ]);
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
    expect(refusalOf(() => boundaryCheck(dir)).split("\n")).toEqual([
      `last-release-sha in release-please-config.json is "${between}", NEWER than ${fx.mergeSha}, the newest release merge this check recognizes.`,
      expect.stringMatching(
        /^A newer release merge's subject stopped matching \/.+\/, or the boundary was edited by hand\.$/,
      ),
      `Investigate RELEASE_SUBJECT, and never roll the boundary back to ${fx.mergeSha} or into the cycle it closed.`,
    ]);
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
    expect(() => boundaryCheck(dir)).toThrow(/outside the cycle[\s\S]*set last-release-sha/);
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
  test("an anchored release PR passes", () => {
    const fx = seedFixture();
    createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
    const worker = clone(fx.root, fx.origin, "anchor-check-worker");
    expect(anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha }).changed).toBe(true);
    const pr = clone(fx.root, fx.origin, "anchor-check-ok");
    git(pr, "checkout", "--quiet", "release-please--branches--main");
    expect(anchorCheck(pr).boundary).toBe(fx.mergeSha);
  });

  test("an anchored release PR stays anchored when a hidden-type commit lands on main, and when main is merged into its branch", () => {
    const fx = seedFixture();
    const { base } = anchoredReleasePr(fx);
    landOnMain(fx, "hidden", "docs: land after the release PR was anchored");
    expect(anchorCheck(releasePrHead(fx, "pr-behind")).boundary).toBe(base);
    updateReleasePrBranch(fx, "update-branch");
    expect(anchorCheck(releasePrHead(fx, "pr-updated")).boundary).toBe(base);
  });

  test.each<[string, (fx: Fixture, pr: AnchoredPr) => Error]>([
    [
      "a refresh dropped the anchor, so the file holds main's own boundary: the stamp repairs it",
      (fx, { base }) => {
        createReleasePrBranch(fx, base, "2.3.0");
        return notAnchored("missing", PLACEHOLDER, base);
      },
    ],
    [
      "the anchor was edited to main's tip after main was merged in: the stamp repairs it",
      (fx, { base }) => {
        const tip = landOnMain(fx, "hidden", "docs: land after the release PR was anchored");
        updateReleasePrBranch(fx, "update-branch");
        anchorByHand(fx, "by-hand", tip);
        return notAnchored("edited", tip, base);
      },
    ],
    [
      "the anchor was edited to a sha that is on no history: the stamp repairs it",
      (fx, { base }) => {
        anchorByHand(fx, "by-hand", "1".repeat(40));
        return notAnchored("edited", "1".repeat(40), base);
      },
    ],
    [
      "the anchor was edited to an older commit of the cycle, which reads as a branch that moved: no stamp is offered",
      (fx, { early, base }) => {
        anchorByHand(fx, "by-hand", early);
        return movedAfterAnchoring(early, base);
      },
    ],
    [
      "main was merged in with the branch as the second parent",
      (fx) => {
        landOnMain(fx, "hidden", "docs: land after the release PR was anchored");
        const dir = clone(fx.root, fx.origin, "wrong-way");
        const subject = "Merge the release branch into main's tip";
        git(dir, "merge", "--quiet", "--no-ff", "-m", subject, `origin/${RELEASE_BRANCH}`);
        git(dir, "push", "--quiet", "origin", `HEAD:refs/heads/${RELEASE_BRANCH}`);
        return noReleaseCommit("origin/main");
      },
    ],
    [
      "release-please's commit sits on a commit that never reached main, anchored there",
      (fx) => {
        const dir = clone(fx.root, fx.origin, "off-main");
        write(dir, "src/marker.ts", "export const marker = 8;\n");
        const offMain = commitAll(dir, "feat: never merged");
        git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/side");
        createReleasePrBranch(fx, offMain, "2.3.0");
        anchorByHand(fx, "by-hand", offMain);
        return new Error(
          [
            `release-please's commit on this release PR sits on ${offMain}, which is not on origin/main as fetched here.`,
            "First fetch main and run the check again:",
            "  git fetch origin",
            "Only when it still fails: the branch was rebased, or a commit was stacked under its release commit.",
            REBUILD,
          ].join("\n"),
        );
      },
    ],
  ])("a release PR is unmergeable once %s", (_name, mutate) => {
    const fx = seedFixture();
    const pr = anchoredReleasePr(fx);
    // The control: the same release PR passes before the change.
    expect(anchorCheck(releasePrHead(fx, "pr-control")).boundary).toBe(pr.base);
    const refusal = mutate(fx, pr);
    expect(() => anchorCheck(releasePrHead(fx, "pr-judged"))).toThrow(refusal);
  });

  test("a release PR branch rebased onto a newer visible commit after it was anchored is refused by the check and by the command, which stamp nothing: its notes lack that commit", async () => {
    const fx = seedFixture();
    const { base } = anchoredReleasePr(fx);
    const unlisted = pushGreenCommit(fx, "unlisted", "bundle-unlisted\n").sha;
    // The control: the anchored release PR passes while it sits on the commit its notes were built from.
    expect(anchorCheck(releasePrHead(fx, "pr-control")).boundary).toBe(base);
    rebaseReleasePrBranch(fx, "update-with-rebase");
    const moved = git(fx.origin, "rev-parse", `refs/heads/${RELEASE_BRANCH}`);
    const refusal = movedAfterAnchoring(base, unlisted).message;

    const checked = refusalOf(() => anchorCheck(releasePrHead(fx, "pr-moved")));
    expect(checked).not.toContain("release-pipeline.ts anchor");
    expect(checked).toBe(refusal);
    // The stamp the check no longer offers, run anyway: from a full clone, and from the hook job's depth-1 checkout, which cannot tell.
    const byHand = await subcommand(
      clone(fx.root, fx.origin, "operator"),
      { GITHUB_SHA: unlisted },
      "anchor",
    );
    const shallow = refusalOf(() =>
      anchorReleasePr({ cwd: shallowClone(fx, "hook-rerun"), sourceSha: unlisted }),
    );
    expect({
      status: byHand.status,
      said: byHand.stderr.trim(),
      shallow,
      head: git(fx.origin, "rev-parse", `refs/heads/${RELEASE_BRANCH}`),
    }).toEqual({
      status: 1,
      said: `release-pipeline anchor: ${refusal}`,
      shallow: [
        `${recording(base)}, and this shallow checkout cannot tell whether that is an older commit than ${unlisted}.`,
        "Run the command from a clone that holds the full history:",
        `  GITHUB_SHA=${unlisted} bun .github/scripts/release-pipeline.ts anchor`,
      ].join("\n"),
      head: moved,
    });

    // The repair the refusal names: release-please's rebuild lists the commit and carries no anchor, so the same command stamps it.
    createReleasePrBranch(fx, unlisted, "2.2.0", true, [base, unlisted]);
    const rebuilt = clone(fx.root, fx.origin, "hook-after-rebuild");
    expect(anchorReleasePr({ cwd: rebuilt, sourceSha: unlisted }).changed).toBe(true);
    expect(anchorCheck(releasePrHead(fx, "pr-rebuilt")).boundary).toBe(unlisted);
  });

  test('the command the refusal names, run from a clean checkout after main moved, anchors the release PR, and answers "already anchored" once it is', async () => {
    const fx = seedFixture();
    const base = pushGreenCommit(fx, "notes-base", "bundle-base\n").sha;
    // A refresh whose hook never ran, then a hidden-type commit: no later run of the pipeline anchors this PR.
    createReleasePrBranch(fx, base, "2.2.0");
    landOnMain(fx, "hidden", "docs: land after the refresh");
    expect(() => anchorCheck(releasePrHead(fx, "pr-unanchored"))).toThrow(
      notAnchored("missing", PLACEHOLDER, base),
    );
    const operator = clone(fx.root, fx.origin, "operator");
    const repair = await subcommand(operator, { GITHUB_SHA: base }, "anchor");
    expect({ status: repair.status, said: repair.stderr.trim().split("\n").at(-1) }).toEqual({
      status: 0,
      said: `release-please--branches--main: anchored at ${base}`,
    });
    expect(anchorCheck(releasePrHead(fx, "pr-repaired")).boundary).toBe(base);
    // The same command against the anchored branch pushes nothing and gives the answer the refusal quotes.
    const anchored = git(fx.origin, "rev-parse", `refs/heads/${RELEASE_BRANCH}`);
    const again = await subcommand(operator, { GITHUB_SHA: base }, "anchor");
    expect({
      status: again.status,
      said: again.stderr.trim(),
      head: git(fx.origin, "rev-parse", `refs/heads/${RELEASE_BRANCH}`),
    }).toEqual({ status: 0, said: "already anchored", head: anchored });
  });

  test("a shallow checkout is refused before any verdict", () => {
    const fx = seedFixture();
    anchoredReleasePr(fx);
    // Depth 1, as the job's checkout was before it asked for the history: the branch's own chain is not in it.
    const dir = join(fx.root, "pr-shallow");
    const branch = ["--branch", RELEASE_BRANCH];
    execFileSync("git", [
      "clone",
      "--quiet",
      "--depth",
      "1",
      ...branch,
      `file://${fx.origin}`,
      dir,
    ]);
    expect(() => anchorCheck(dir)).toThrow(
      new Error(
        "anchor-check needs the full history (fetch-depth: 0) and this checkout is shallow: the commit release-please built the " +
          "branch on is read from the branch's own history.",
      ),
    );
  });
});

describe("the release hook's reads of the draft", () => {
  /** A gh first on PATH that logs its argv and answers with the planned stdout, or the planned stderr and status. */
  type Gh = { stdout?: string; stderr?: string; status?: number };
  function runWithGh(gh: Gh, env: Record<string, string | undefined>, subcommand: string) {
    return withTempDir("release-draft-", (dir) => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(dir, "answer"), gh.stdout ?? "");
      writeFileSync(join(dir, "answer.err"), gh.stderr ?? "");
      writeFileSync(
        join(bin, "gh"),
        [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> "${dir}/calls.log"`,
          `cat "${dir}/answer"`,
          `cat "${dir}/answer.err" >&2`,
          `exit ${gh.status ?? 0}`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const step = runStep(
        "release-pipeline",
        ROOT,
        join(dir, "runner"),
        { TAG: "v2.1.0", ...env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        subcommand,
      );
      const log = join(dir, "calls.log");
      const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      return { ...step, calls };
    });
  }
  const sha = "b8df084c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a";
  const VIEW_SOURCE = "release view v2.1.0 --json targetCommitish --jq .targetCommitish";
  const VIEW_ASSETS = "release view v2.1.0 --json assets";
  const assets = (...names: string[]): string =>
    `${JSON.stringify({ assets: names.map((name) => ({ name })) })}\n`;

  // The whole step per case: what gh was asked, what the step printed and wrote, and how it ended. The draft is
  // read by tag alone, and a refusal is the annotation the shell step printed.
  test.each<
    [
      name: string,
      subcommand: string,
      gh: Gh,
      expected: {
        stdout: string;
        stderr: string;
        status: number;
        outputs: string[];
        calls: string[];
      },
    ]
  >([
    [
      "resolve-source: a draft targeting the merge commit writes it as the step output",
      "resolve-source",
      { stdout: `${sha}\n` },
      { stdout: "", stderr: "", status: 0, outputs: [`sha=${sha}`], calls: [VIEW_SOURCE] },
    ],
    [
      "resolve-source: a draft targeting a branch name is refused before anything checks it out",
      "resolve-source",
      { stdout: "main\n" },
      {
        stdout:
          "::error::draft v2.1.0's target commitish is 'main', not a commit SHA; refusing to package an unidentified source.\n",
        stderr: "",
        status: 1,
        outputs: [],
        calls: [VIEW_SOURCE],
      },
    ],
    [
      "resolve-source: a gh that fails ends the step with its status and stderr, writing no output",
      "resolve-source",
      { stderr: "release not found\n", status: 4 },
      { stdout: "", stderr: "release not found\n", status: 4, outputs: [], calls: [VIEW_SOURCE] },
    ],
    [
      "verify-assets: both packaged assets beside the attestation pass silently",
      "verify-assets",
      { stdout: assets("settings.schema.json", "attestation.json", "index.js") },
      { stdout: "", stderr: "", status: 0, outputs: [], calls: [VIEW_ASSETS] },
    ],
    [
      "verify-assets: a draft missing an asset fails naming what it carries",
      "verify-assets",
      { stdout: assets("index.js") },
      {
        stdout:
          "::error::release v2.1.0 carries assets [index.js], expected [index.js settings.schema.json]; " +
          "re-run package-release before anything publishes.\n",
        stderr: "",
        status: 1,
        outputs: [],
        calls: [VIEW_ASSETS],
      },
    ],
    [
      "verify-assets: an assetless draft fails the same way",
      "verify-assets",
      { stdout: assets() },
      {
        stdout:
          "::error::release v2.1.0 carries assets [], expected [index.js settings.schema.json]; " +
          "re-run package-release before anything publishes.\n",
        stderr: "",
        status: 1,
        outputs: [],
        calls: [VIEW_ASSETS],
      },
    ],
    [
      "verify-assets: a draft carrying an asset beyond the two fails naming it, so a stray upload never publishes",
      "verify-assets",
      { stdout: assets("index.js", "settings.schema.json", "extra.txt") },
      {
        stdout:
          "::error::release v2.1.0 carries assets [extra.txt index.js settings.schema.json], expected " +
          "[index.js settings.schema.json]; re-run package-release before anything publishes.\n",
        stderr: "",
        status: 1,
        outputs: [],
        calls: [VIEW_ASSETS],
      },
    ],
    [
      "verify-assets: a gh that fails ends the step with its status and stderr",
      "verify-assets",
      { stderr: "release not found\n", status: 4 },
      { stdout: "", stderr: "release not found\n", status: 4, outputs: [], calls: [VIEW_ASSETS] },
    ],
  ])("%s", async (_name, subcommand, gh, expected) => {
    expect(await runWithGh(gh, {}, subcommand)).toEqual(expected);
  });

  test.each(["resolve-source", "verify-assets"])(
    "%s without TAG is refused before gh is asked",
    async (subcommand) => {
      expect(await runWithGh({ stdout: `${sha}\n` }, { TAG: undefined }, subcommand)).toEqual({
        stdout: "",
        stderr: "TAG must be set for this step\n",
        status: 1,
        outputs: [],
        calls: [],
      });
    },
  );
});

describe("the release-please config", () => {
  const malformed: [string, string, RegExp][] = [
    [
      "not JSON",
      "{ not json\n",
      /^release-please-config\.json is not valid JSON \(.+\)\.\nFix it by PR\.$/,
    ],
    [
      "a JSON array",
      "[]\n",
      /^release-please-config\.json holds an array, not a JSON object\.\nFix it by PR\.$/,
    ],
    [
      "a boundary that is not a commit sha",
      `${JSON.stringify({ "last-release-sha": 42, packages: {} })}\n`,
      /^last-release-sha in release-please-config\.json is 42, not a 40-hex commit sha\.\nFix it by PR\.$/,
    ],
  ];
  test.each(malformed)(
    "a config that is %s is refused naming the file by every subcommand that reads it",
    (_name, text, error) => {
      const fx = seedFixture();
      createReleasePrBranch(fx, fx.mergeSha, "2.2.0");
      const checker = clone(fx.root, fx.origin, "config-boundary");
      write(checker, "release-please-config.json", text);
      expect(() => boundaryCheck(checker)).toThrow(error);
      const pr = clone(fx.root, fx.origin, "config-anchor-check");
      git(pr, "checkout", "--quiet", "release-please--branches--main");
      write(pr, "release-please-config.json", text);
      expect(() => anchorCheck(pr)).toThrow(error);
      const branch = clone(fx.root, fx.origin, "config-branch");
      git(branch, "checkout", "--quiet", "release-please--branches--main");
      write(branch, "release-please-config.json", text);
      commitAll(branch, "chore: a config release-please would not write");
      git(branch, "push", "--quiet", "origin", "HEAD:refs/heads/release-please--branches--main");
      const worker = clone(fx.root, fx.origin, "config-anchor");
      expect(() => anchorReleasePr({ cwd: worker, sourceSha: fx.mergeSha })).toThrow(error);
    },
  );

  test("a missing config is refused naming the file and where it was looked for", () => {
    const fx = seedFixture();
    const checker = clone(fx.root, fx.origin, "config-missing");
    rmSync(join(checker, "release-please-config.json"));
    expect(() => boundaryCheck(checker)).toThrow(
      new Error(
        `release-please-config.json is missing from ${checker}: the release pipeline reads release-please's boundary (last-release-sha) from it.\n` +
          "Restore it by PR.",
      ),
    );
  });
});

describe("release configuration contract", () => {
  test("release-please cuts a tagless draft and leaves the release to the hook: no tag ever lands on main, and the release job runs from the hook", () => {
    // An external tool's knobs the platform does not enforce: a tag release-please created would sit on main, and
    // skip-github-release would leave release_created unfired, so the hook that packages and tags never runs.
    // release-please resolves each knob per package first, then from the top level, then its default.
    const config = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8")) as {
      "skip-github-release"?: boolean;
      packages: Record<
        string,
        { draft?: boolean; "force-tag-creation"?: boolean; "skip-github-release"?: boolean }
      >;
    };
    const root = config.packages["."];
    expect({
      draft: root?.draft,
      forceTagCreation: root?.["force-tag-creation"],
      skipGithubRelease: root?.["skip-github-release"] ?? config["skip-github-release"] ?? false,
    }).toEqual({ draft: true, forceTagCreation: false, skipGithubRelease: false });
  });
});
