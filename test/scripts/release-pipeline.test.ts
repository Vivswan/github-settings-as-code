/**
 * The release pipeline against local fixture repositories (a bare origin plus clones playing the CI checkouts), so the tag topology is a unit test
 * rather than what the first real release discovers.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  FROZEN,
  packageCommit,
  packageRelease,
  retagMajor,
  versionTagOf,
} from "../../.github/scripts/release-pipeline/tags.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";
import {
  BOT_IDENTITY,
  buildTagOf,
  buildTags,
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
  pushMarker,
  remoteRef,
  rivalPackage,
  seedFixture,
  shallowClone,
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
const MARKER = "refs/tags/source-v2.1.0";

describe("packageRelease", () => {
  test("a fresh release mints the merge commit's package under its build tag, tags it, and creates latest, leaving the marker on the merge commit; a rerun verifies it and pushes nothing", () => {
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
    expect(git(fx.origin, "rev-parse", MARKER)).toBe(fx.mergeSha);
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
    // A pre-release: no version ref derives from it.
    ["v2.1-rc.0", /not a vX\.Y\.Z release tag/],
    // The marker itself, unparsed: package takes the version tag resolve-source parsed from it.
    ["source-v2.1.0", /not a vX\.Y\.Z release tag/],
    // Well-shaped, but not the version this source's manifest released.
    ["v2.2.0", /did not release/],
  ])("the tag %s mints nothing", (tag, error) => {
    const fx = seedFixture();
    const pushes = withPushPlans(fx, [], () => {
      expect(() => packageRelease({ cwd: fx.work, tag, sourceSha: fx.mergeSha })).toThrow(error);
    });
    expect(pushes).toEqual([]);
    expect(git(fx.origin, "rev-parse", MARKER)).toBe(fx.mergeSha);
    expect(buildTags(fx)).toEqual([]);
  });

  // release-please ignores a marker it could not create and reports nothing for one on another commit, so the hook
  // holds the marker to the merge commit before its first push.
  test.each<
    [state: string, plant: (fx: Fixture) => string, repair: (fx: Fixture, at: string) => string]
  >([
    [
      "missing on origin",
      (fx) => {
        git(fx.work, "push", "--quiet", "origin", `:${MARKER}`);
        return "";
      },
      (fx) =>
        `${MARKER} is missing on origin; release-please finds this release by that tag on the release merge ${fx.mergeSha}.\n` +
        "Create it, then rerun this job:\n" +
        `git push origin ${fx.mergeSha}:${MARKER}`,
    ],
    [
      "on the packaged commit",
      (fx) => {
        const packaged = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha }).commit;
        git(fx.work, "push", "--quiet", "--force", "origin", `${packaged}:${MARKER}`);
        return packaged;
      },
      (fx, at) =>
        `${MARKER} points at ${at}, not at the release merge ${fx.mergeSha}; release-please would start the next changelog from the wrong commit.\n` +
        "Move it as a repository admin (the source-tags ruleset freezes it), then rerun this job:\n" +
        `git push --force origin ${fx.mergeSha}:${MARKER}`,
    ],
    [
      "on another release's merge",
      (fx) => {
        git(fx.work, "push", "--quiet", "--force", "origin", `${fx.seedSha}:${MARKER}`);
        return fx.seedSha;
      },
      (fx, at) =>
        `${MARKER} points at ${at}, not at the release merge ${fx.mergeSha}; release-please would start the next changelog from the wrong commit.\n` +
        "Move it as a repository admin (the source-tags ruleset freezes it), then rerun this job:\n" +
        `git push --force origin ${fx.mergeSha}:${MARKER}`,
    ],
  ])(
    "the marker %s stops the release before any push, naming its repair",
    (_state, plant, repair) => {
      const fx = seedFixture();
      const at = plant(fx);
      const release = checkoutOf(fx, "release", fx.mergeSha, "packaged-bundle-bytes-1\n");
      let error: unknown;
      const pushes = withPushPlans(fx, [], () => {
        try {
          packageRelease({ cwd: release, tag: "v2.1.0", sourceSha: fx.mergeSha });
        } catch (thrown) {
          error = thrown;
        }
      });
      expect(error).toEqual(new Error(repair(fx, at)));
      expect(pushes).toEqual([]);
      expect(remoteRef(fx, TAG)).toBe("");
    },
  );

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
  pushMarker(dir, version, mergeSha);
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
        {
          MARKER: "source-v2.1.0",
          TAG: "v2.1.0",
          ...env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        subcommand,
      );
      const log = join(dir, "calls.log");
      const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      return { ...step, calls };
    });
  }
  const sha = "b8df084c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a";
  const VIEW_SOURCE = "release view source-v2.1.0 --json targetCommitish --jq .targetCommitish";
  const VIEW_ASSETS = "release view source-v2.1.0 --json assets";
  const RENAME = "release edit source-v2.1.0 --tag v2.1.0 --title v2.1.0 --verify-tag";
  const assets = (...names: string[]): string =>
    `${JSON.stringify({ assets: names.map((name) => ({ name })) })}\n`;

  // The whole step per case: what gh was asked, what the step printed and wrote, and how it ended. The draft is
  // read and renamed under the name release-please gave it, and a refusal is the annotation the shell step printed.
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
      "resolve-source: a draft targeting the merge commit writes it and the version tag source-v2.1.0 names as the step outputs",
      "resolve-source",
      { stdout: `${sha}\n` },
      {
        stdout: "",
        stderr: "",
        status: 0,
        outputs: [`sha=${sha}`, "tag=v2.1.0"],
        calls: [VIEW_SOURCE],
      },
    ],
    [
      "resolve-source: a draft targeting a branch name is refused before anything checks it out",
      "resolve-source",
      { stdout: "main\n" },
      {
        stdout:
          "::error::draft source-v2.1.0's target commitish is 'main', not a commit SHA; refusing to package an unidentified source.\n",
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
          "::error::release source-v2.1.0 carries assets [index.js], expected [index.js settings.schema.json]; " +
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
          "::error::release source-v2.1.0 carries assets [], expected [index.js settings.schema.json]; " +
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
          "::error::release source-v2.1.0 carries assets [extra.txt index.js settings.schema.json], expected " +
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
    [
      "rename-draft: the draft takes the version tag as its tag and title, held to a tag origin has, and stays a draft",
      "rename-draft",
      {},
      { stdout: "", stderr: "", status: 0, outputs: [], calls: [RENAME] },
    ],
    [
      "rename-draft: a gh that fails ends the step with its status and stderr",
      "rename-draft",
      {
        stderr: "tag v2.1.0 doesn't exist in the repo o/r, aborting due to --verify-tag flag\n",
        status: 1,
      },
      {
        stdout: "",
        stderr: "tag v2.1.0 doesn't exist in the repo o/r, aborting due to --verify-tag flag\n",
        status: 1,
        outputs: [],
        calls: [RENAME],
      },
    ],
  ])("%s", async (_name, subcommand, gh, expected) => {
    expect(await runWithGh(gh, {}, subcommand)).toEqual(expected);
  });

  test.each<[subcommand: string, unset: string]>([
    ["resolve-source", "MARKER"],
    ["verify-assets", "MARKER"],
    ["rename-draft", "MARKER"],
    ["rename-draft", "TAG"],
  ])("%s without %s is refused before gh is asked", async (subcommand, unset) => {
    expect(await runWithGh({ stdout: `${sha}\n` }, { [unset]: undefined }, subcommand)).toEqual({
      stdout: "",
      stderr: `${unset} must be set for this step\n`,
      status: 1,
      outputs: [],
      calls: [],
    });
  });

  test.each<[what: string, handed: string]>([
    ["the version tag itself", "v2.1.0"],
    ["a name without the v", "source-2.1.0"],
    ["another component's tag", "other-v2.1.0"],
    ["a pre-release", "source-v2.1.0-rc.1"],
    ["a two-part version", "source-v2.1"],
    ["a word that is no tag", "release"],
  ])(
    "resolve-source: handed %s, it refuses the name before gh is asked and derives no version tag",
    async (_what, handed) => {
      expect(await runWithGh({ stdout: `${sha}\n` }, { MARKER: handed }, "resolve-source")).toEqual(
        {
          stdout: "",
          stderr:
            `release-pipeline resolve-source: the handed tag "${handed}" is not source-vX.Y.Z, the name release-please gives a release here; ` +
            "refusing to derive a version tag from it.\n" +
            'Fix release-please-config.json by PR: "include-component-in-tag": true at the top, "component": "source" on package ".".\n',
          status: 1,
          outputs: [],
          calls: [],
        },
      );
    },
  );

  test("handed source-v2.1.0, the hook mints v2.1.0 on the merge commit's package and pushes no source-v* tag", async () => {
    const fx = seedFixture();
    const resolved = await runWithGh({ stdout: `${fx.mergeSha}\n` }, {}, "resolve-source");
    expect(resolved.outputs).toEqual([`sha=${fx.mergeSha}`, "tag=v2.1.0"]);
    const [sourceSha = "", tag = ""] = resolved.outputs.map((line) => line.slice(4));
    let step: ReturnType<typeof runStep> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      step = runStep(
        "release-pipeline",
        fx.work,
        join(fx.root, "runner"),
        { TAG: tag, GITHUB_SHA: sourceSha, RUN_URL: undefined },
        "package",
      );
    });
    expect(step?.status, step?.stderr).toBe(0);
    const packaged = git(fx.origin, "rev-parse", `${TAG}^{}`);
    expect(parentsOf(fx.origin, packaged)).toEqual([fx.mergeSha]);
    expect(pushes).toEqual([
      createOf(packaged, buildTagOf(fx, fx.mergeSha)),
      createOf(packaged, TAG),
      moveOf(LATEST, "", packaged),
    ]);
    expect(git(fx.origin, "rev-parse", MARKER)).toBe(fx.mergeSha);
  });
});

describe("release configuration contract", () => {
  test("the name release-please gives a release under release-please-config.json is one the hook parses", () => {
    // release-please names the root package's tag <component>-v<version> when the component is in the tag, else
    // v<version>; it reads each key per package first, then from the top level, and puts the component in by default.
    type Naming = { "include-component-in-tag"?: boolean; component?: string };
    const config = JSON.parse(
      readFileSync(join(ROOT, "release-please-config.json"), "utf8"),
    ) as Naming & { packages: Record<string, Naming> };
    const root = config.packages["."];
    const inTag = root?.["include-component-in-tag"] ?? config["include-component-in-tag"] ?? true;
    const name = inTag && root?.component ? `${root.component}-v1.2.3` : "v1.2.3";
    expect(versionTagOf(name)).toBe("v1.2.3");
  });
});
