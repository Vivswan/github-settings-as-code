/**
 * packageCommit against the fixture repositories: every green main commit gets its own packaged commit under its
 * build tag, latest moves forward alone, the window is pruned, and every interleaving with a rival run lands where
 * the topology says whatever order the runs finish in.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  KEPT_BUILD_TAGS,
  movePointer,
  packageCommit,
  packageRelease,
  pruneBuildTags,
  retagMajor,
} from "../../.github/scripts/release-pipeline.js";
import {
  buildTagOf,
  buildTags,
  builtFiles,
  checkoutOf,
  clone,
  commitAll,
  createdSha,
  createOf,
  deleteOf,
  expectPackage,
  FIXTURE_IDENTITY,
  type Fixture,
  git,
  installReleasePipelineFixture,
  LATEST,
  latestTag,
  localIdentity,
  manifestJson,
  moveOf,
  originHolds,
  PERMANENT,
  PLANTED_PACKAGES,
  packagedOf,
  parentsOf,
  plantCommit,
  plantCommitIn,
  positionOf,
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

const RUN_URL = "https://example.invalid/actions/runs/7";

/** A run's result with latest's reason left out: the pointer's sha and whether it moved are what the run did. */
const outcome = (result: ReturnType<typeof packageCommit>) => ({
  created: result.created,
  ref: result.ref,
  commit: result.commit,
  source: result.source,
  pruned: result.pruned,
  latest: { sha: result.latest.sha, changed: result.latest.changed },
});

describe("packageCommit", () => {
  test("the first green commit is packaged under its build tag as the commit's child and latest is created; a rerun verifies both and pushes nothing", () => {
    const fx = seedFixture();
    let result: ReturnType<typeof packageCommit> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha, runUrl: RUN_URL });
    });
    const ref = buildTagOf(fx, fx.mergeSha);
    const packaged = packagedOf(fx, fx.mergeSha);
    expect(result && outcome(result)).toEqual({
      created: true,
      ref,
      commit: packaged,
      source: fx.mergeSha,
      pruned: [],
      latest: { sha: packaged, changed: true },
    });
    expect(ref).toBe(`refs/tags/build/2.${fx.mergeSha.slice(0, 7)}`);
    expect(pushes).toEqual([createOf(packaged, ref), moveOf(LATEST, "", packaged)]);
    expect(buildTags(fx)).toEqual([ref]);
    expect(latestTag(fx)).toBe(packaged);
    expectPackage(fx, packaged, fx.mergeSha, "packaged-bundle-bytes-1", RUN_URL);
    expect(localIdentity(fx.work)).toBe(FIXTURE_IDENTITY);
    expect(git(fx.work, "rev-parse", "HEAD")).toBe(fx.mergeSha);
    expect(git(fx.work, "status", "--porcelain")).toBe("");

    const rerun = checkoutOf(fx, "rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let again: ReturnType<typeof packageCommit> | undefined;
    const rerunPushes = withPushPlans(fx, [], () => {
      again = packageCommit({ cwd: rerun, sourceSha: fx.mergeSha });
    });
    expect(again && outcome(again)).toEqual({
      created: false,
      ref,
      commit: packaged,
      source: fx.mergeSha,
      pruned: [],
      latest: { sha: packaged, changed: false },
    });
    expect(rerunPushes).toEqual([]);
    expect(buildTags(fx)).toEqual([ref]);
    expect(latestTag(fx)).toBe(packaged);
  });

  test("a newer commit's run moves latest forward under a lease on the value it read; a run for the older commit after it leaves latest there", () => {
    const fx = seedFixture();
    const first = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha }).commit;
    // Cloned BEFORE the newer commit exists: the stale run must learn it from origin.
    const stale = checkoutOf(fx, "stale", fx.mergeSha, "packaged-bundle-bytes-1\n");
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    let second: ReturnType<typeof packageCommit> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      second = packageCommit({ cwd: next.dir, sourceSha: next.sha });
    });
    const packaged = packagedOf(fx, next.sha);
    expect(second && outcome(second)).toEqual({
      created: true,
      ref: buildTagOf(fx, next.sha),
      commit: packaged,
      source: next.sha,
      pruned: [],
      latest: { sha: packaged, changed: true },
    });
    expect(pushes).toEqual([
      createOf(packaged, buildTagOf(fx, next.sha)),
      moveOf(LATEST, first, packaged),
    ]);
    expect(parentsOf(fx.origin, packaged)).toEqual([next.sha]);
    expect(git(fx.origin, "show", `${packaged}:src/marker.ts`)).toBe(
      'export const marker = "second-green";',
    );

    let staleResult: ReturnType<typeof packageCommit> | undefined;
    const stalePushes = withPushPlans(fx, [], () => {
      staleResult = packageCommit({ cwd: stale, sourceSha: fx.mergeSha });
    });
    expect(staleResult && outcome(staleResult)).toEqual({
      created: false,
      ref: buildTagOf(fx, fx.mergeSha),
      commit: first,
      source: fx.mergeSha,
      pruned: [],
      latest: { sha: packaged, changed: false },
    });
    expect(stalePushes).toEqual([]);
    expect(latestTag(fx)).toBe(packaged);
  });

  /** Origin's consumable state with the commit shas abstracted away: the tags by position and tree, latest by the
   * source it packages and its tree. Two fixtures seeded alike hold the same trees, so the same state means the
   * same outcome. */
  function consumableState(fx: Fixture): unknown {
    return {
      tags: buildTags(fx).map((ref) => ({
        position: Number(ref.match(/build\/(\d+)\./)?.[1]),
        tree: git(fx.origin, "rev-parse", `${ref}^{tree}`),
        packages: positionOf(
          fx,
          parentsOf(fx.origin, git(fx.origin, "rev-parse", `${ref}^{}`))[0] ?? "",
        ),
      })),
      latest: {
        packages: positionOf(fx, parentsOf(fx.origin, latestTag(fx))[0] ?? ""),
        isBuildTagCommit: buildTags(fx).some(
          (ref) => git(fx.origin, "rev-parse", `${ref}^{}`) === latestTag(fx),
        ),
        tree: git(fx.origin, "rev-parse", `${latestTag(fx)}^{tree}`),
      },
    };
  }

  test("two commits' runs end in the same state whichever finishes first", () => {
    const inOrder = seedFixture();
    const b = pushGreenCommit(inOrder, "second-green", "packaged-bundle-bytes-2\n");
    packageCommit({ cwd: inOrder.work, sourceSha: inOrder.mergeSha });
    packageCommit({ cwd: b.dir, sourceSha: b.sha });

    const reversed = seedFixture();
    const b2 = pushGreenCommit(reversed, "second-green", "packaged-bundle-bytes-2\n");
    const aRun = checkoutOf(reversed, "a-late", reversed.mergeSha, "packaged-bundle-bytes-1\n");
    packageCommit({ cwd: b2.dir, sourceSha: b2.sha });
    const late = packageCommit({ cwd: aRun, sourceSha: reversed.mergeSha });

    expect(late.created).toBe(true);
    expect(late.latest).toMatchObject({ sha: packagedOf(reversed, b2.sha), changed: false });
    expect(consumableState(reversed)).toEqual(consumableState(inOrder));
    expect(consumableState(inOrder)).toEqual({
      tags: [
        { position: 2, tree: expect.stringMatching(/^[0-9a-f]{40}$/), packages: 2 },
        { position: 3, tree: expect.stringMatching(/^[0-9a-f]{40}$/), packages: 3 },
      ],
      latest: {
        packages: 3,
        isBuildTagCommit: true,
        tree: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    });
  });

  test("a rerun whose build differs from the tag's stops loudly, naming both trees, and pushes nothing", () => {
    const fx = seedFixture();
    packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
    const ref = buildTagOf(fx, fx.mergeSha);
    const packaged = packagedOf(fx, fx.mergeSha);
    const rerun = checkoutOf(fx, "rerun-drift", fx.mergeSha, "DIFFERENT-bytes\n");
    let error: unknown;
    const pushes = withPushPlans(fx, [], () => {
      try {
        packageCommit({ cwd: rerun, sourceSha: fx.mergeSha });
      } catch (thrown) {
        error = thrown;
      }
    });
    expect(String((error as Error).message)).toMatch(
      new RegExp(
        `^${ref} \\(${packaged}\\) packages ${fx.mergeSha}, but its tree [0-9a-f]{40} is not the tree [0-9a-f]{40} ` +
          "this checkout's build packages, so the two differ under lib/index\\.js, lib/settings\\.schema\\.json, and lib/pkg/.*Diff the two trees by hand; " +
          "no run replaces a packaged commit it did not mint; if the build is wrong, delete the tag by hand and rerun\\.$",
      ),
    );
    expect(pushes).toEqual([]);
    expect(packagedOf(fx, fx.mergeSha)).toBe(packaged);
    expect(latestTag(fx)).toBe(packaged);
  });

  test.each(PLANTED_PACKAGES)(
    "a hand-planted build tag that is %s stops the run and stays put",
    (_name, plant) => {
      const fx = seedFixture();
      const { from, sha, error } = plant(fx);
      const ref = buildTagOf(fx, fx.mergeSha);
      git(from, "push", "--quiet", "origin", `${sha}:${ref}`);
      let thrown: unknown;
      const pushes = withPushPlans(fx, [], () => {
        try {
          packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
        } catch (caught) {
          thrown = caught;
        }
      });
      const message = String((thrown as Error).message);
      expect(message).toMatch(error);
      expect(message.startsWith(`${ref} (${sha})`)).toBe(true);
      expect(
        message.endsWith(
          "no run replaces a packaged commit it did not mint; if the build is wrong, delete the tag by hand and rerun.",
        ),
      ).toBe(true);
      expect(pushes).toEqual([]);
      expect(git(fx.origin, "rev-parse", `${ref}^{}`)).toBe(sha);
      expect(remoteRef(fx, LATEST)).toBe("");
    },
  );

  test("a rival run creating the tag between the read and the push is verified, and its commit is what latest names", () => {
    const fx = seedFixture();
    const ref = buildTagOf(fx, fx.mergeSha);
    const rival = rivalPackage(fx, "rival-same", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageCommit> | undefined;
    const pushes = withPushPlans(
      fx,
      [{ competitor: { from: rival.from, sha: rival.sha, ref } }],
      () => {
        result = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
      },
    );
    expect(result && outcome(result)).toEqual({
      created: false,
      ref,
      commit: rival.sha,
      source: fx.mergeSha,
      pruned: [],
      latest: { sha: rival.sha, changed: true },
    });
    const rejected = createdSha(pushes[0] ?? []);
    expect(rejected).not.toBe(rival.sha);
    expect(pushes).toEqual([createOf(rejected, ref), moveOf(LATEST, "", rival.sha)]);
    expect(packagedOf(fx, fx.mergeSha)).toBe(rival.sha);
    expect(latestTag(fx)).toBe(rival.sha);
  });

  test("a rival run creating the tag with a build this checkout does not reproduce stops the run", () => {
    const fx = seedFixture();
    const ref = buildTagOf(fx, fx.mergeSha);
    const rival = rivalPackage(fx, "rival-other", fx.mergeSha, "competitor-bundle\n");
    const pushes = withPushPlans(
      fx,
      [{ competitor: { from: rival.from, sha: rival.sha, ref } }],
      () => {
        expect(() => packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(
          /packages [0-9a-f]{40}, but its tree [0-9a-f]{40} is not the tree [0-9a-f]{40} this checkout's build packages/,
        );
      },
    );
    expect(pushes).toHaveLength(1);
    expect(packagedOf(fx, fx.mergeSha)).toBe(rival.sha);
    expect(remoteRef(fx, LATEST)).toBe("");
  });

  test("a latest lease overtaken by a hand move to a bare main commit is retried on the re-observed value and replaces it", () => {
    const fx = seedFixture();
    const ref = buildTagOf(fx, fx.mergeSha);
    let result: ReturnType<typeof packageCommit> | undefined;
    // The seed is a root of main: with no parent it is no package, so it is replaced, not judged.
    const pushes = withPushPlans(
      fx,
      [null, { competitor: { from: fx.work, sha: fx.seedSha, ref: LATEST } }],
      () => {
        result = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
      },
    );
    const packaged = packagedOf(fx, fx.mergeSha);
    expect(result?.latest).toMatchObject({ sha: packaged, changed: true });
    expect(pushes).toEqual([
      createOf(packaged, ref),
      moveOf(LATEST, "", packaged),
      moveOf(LATEST, fx.seedSha, packaged),
    ]);
    expect(latestTag(fx)).toBe(packaged);
  });

  test("a latest lease overtaken on every attempt gives up naming the concurrent mover, with the tag minted", () => {
    const fx = seedFixture();
    const ref = buildTagOf(fx, fx.mergeSha);
    const movers = [fx.seedSha, fx.mergeSha, fx.seedSha];
    const pushes = withPushPlans(
      fx,
      [null, ...movers.map((sha) => ({ competitor: { from: fx.work, sha, ref: LATEST } }))],
      () => {
        expect(() => packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(
          `could not move ${LATEST} after 3 compare-and-swap attempts; something keeps moving it concurrently - rerun this job once it settles.`,
        );
      },
    );
    const packaged = packagedOf(fx, fx.mergeSha);
    expect(pushes).toEqual([
      createOf(packaged, ref),
      moveOf(LATEST, "", packaged),
      moveOf(LATEST, fx.seedSha, packaged),
      moveOf(LATEST, fx.mergeSha, packaged),
    ]);
    expect(latestTag(fx)).toBe(fx.seedSha);
  });

  test("a newer commit landing and taking latest after this run read main's head leaves latest there: the head is re-read after the pointer", () => {
    const fx = seedFixture();
    // B, its package, and its build tag exist only in this clone until the plan pushes them, right before this
    // run's first push; the prune lists the tag and keeps it (the window is not full).
    const next = clone(fx.root, fx.origin, "next");
    write(next, "src/marker.ts", 'export const marker = "second-green";\n');
    const b = commitAll(next, "feat: second-green");
    const pb = plantCommitIn(next, b, b, builtFiles("packaged-bundle-bytes-2\n"), [
      "build: by another run",
    ]);
    const landing = `git -C "${next}" push --quiet origin ${b}:refs/heads/main ${pb}:${LATEST} ${pb}:refs/tags/build/3.${b.slice(0, 7)}\n`;
    let result: ReturnType<typeof packageCommit> | undefined;
    const pushes = withPushPlans(fx, [{ script: landing }], () => {
      result = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
    });
    const packaged = packagedOf(fx, fx.mergeSha);
    expect(result && outcome(result)).toEqual({
      created: true,
      ref: buildTagOf(fx, fx.mergeSha),
      commit: packaged,
      source: fx.mergeSha,
      pruned: [],
      latest: { sha: pb, changed: false },
    });
    expect(pushes).toEqual([createOf(packaged, buildTagOf(fx, fx.mergeSha))]);
    expect(latestTag(fx)).toBe(pb);
    expect(buildTags(fx).sort()).toEqual(
      [buildTagOf(fx, fx.mergeSha), `refs/tags/build/3.${b.slice(0, 7)}`].sort(),
    );
  });

  test("a hand-pushed latest at a bare child of a newer main commit stops a run for an older commit instead of standing as already past", () => {
    const fx = seedFixture();
    const b = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    // A child of B with B's tree and no build: its parent is on main, so ancestry alone would read it as newer.
    const bare = git(b.dir, "commit-tree", `${b.sha}^{tree}`, "-p", b.sha, "-m", "by hand");
    git(b.dir, "push", "--quiet", "origin", `${bare}:${LATEST}`);
    const stale = checkoutOf(fx, "stale", fx.mergeSha, "packaged-bundle-bytes-1\n");
    const pushes = withPushPlans(fx, [], () => {
      expect(() => packageCommit({ cwd: stale, sourceSha: fx.mergeSha })).toThrow(
        new RegExp(
          `^${LATEST} \\(${bare}\\) is not ${b.sha} plus lib/index\\.js, lib/settings\\.schema\\.json, and lib/pkg/, minus package\\.json's preparation scripts, alone: .*; inspect it by hand\\.$`,
        ),
      );
    });
    expect(pushes).toEqual([createOf(packagedOf(fx, fx.mergeSha), buildTagOf(fx, fx.mergeSha))]);
    expect(latestTag(fx)).toBe(bare);
  });

  test("latest moving between its observation and its fetch is read again, and the newer value is judged", () => {
    const fx = seedFixture();
    const b = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const pb = packageCommit({ cwd: b.dir, sourceSha: b.sha }).commit;
    const c = pushGreenCommit(fx, "third-green", "packaged-bundle-bytes-3\n");
    const pc = rivalPackage(fx, "third-package", c.sha, "packaged-bundle-bytes-3\n");
    const stale = checkoutOf(fx, "stale", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageCommit> | undefined;
    const pushes = withPushPlans(
      fx,
      [],
      () => {
        result = packageCommit({ cwd: stale, sourceSha: fx.mergeSha });
      },
      {
        naming: LATEST,
        script: `git -C "${pc.from}" push --quiet --force origin ${pc.sha}:${LATEST}\n`,
      },
    );
    expect(result?.latest).toMatchObject({ sha: pc.sha, changed: false });
    expect(pushes).toEqual([createOf(packagedOf(fx, fx.mergeSha), buildTagOf(fx, fx.mergeSha))]);
    expect(latestTag(fx)).toBe(pc.sha);
    expect(pb).not.toBe(pc.sha);
  });

  test("a build tag deleted and re-created between its observation and its fetch is read again and verified", () => {
    const fx = seedFixture();
    const first = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha }).commit;
    const ref = buildTagOf(fx, fx.mergeSha);
    const again = rivalPackage(fx, "again", fx.mergeSha, "packaged-bundle-bytes-1\n");
    const rerun = checkoutOf(fx, "rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageCommit> | undefined;
    const pushes = withPushPlans(
      fx,
      [],
      () => {
        result = packageCommit({ cwd: rerun, sourceSha: fx.mergeSha });
      },
      {
        naming: ref,
        script: `git -C "${fx.origin}" update-ref -d ${ref} && git -C "${again.from}" push --quiet origin ${again.sha}:${ref}\n`,
      },
    );
    // latest still names the first commit of the package: another commit of the same package leaves it.
    expect(result && outcome(result)).toEqual({
      created: false,
      ref,
      commit: again.sha,
      source: fx.mergeSha,
      pruned: [],
      latest: { sha: first, changed: false },
    });
    expect(pushes).toEqual([]);
    expect(latestTag(fx)).toBe(first);
  });

  test("a build tag pruned between its observation and its fetch is minted again", () => {
    const fx = seedFixture();
    const first = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha }).commit;
    const ref = buildTagOf(fx, fx.mergeSha);
    // latest is past the merge commit, as it is whenever the window has moved on far enough to prune its tag.
    const b = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const pb = packageCommit({ cwd: b.dir, sourceSha: b.sha }).commit;
    const rerun = checkoutOf(fx, "rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageCommit> | undefined;
    const pushes = withPushPlans(
      fx,
      [],
      () => {
        // Another run URL, so the re-minted commit is its own sha whatever the clock says.
        result = packageCommit({ cwd: rerun, sourceSha: fx.mergeSha, runUrl: RUN_URL });
      },
      { naming: ref, script: `git -C "${fx.origin}" update-ref -d ${ref}\n` },
    );
    const reminted = packagedOf(fx, fx.mergeSha);
    expect(reminted).not.toBe(first);
    expect(git(rerun, "rev-parse", `${reminted}^{tree}`)).toBe(
      git(fx.origin, "rev-parse", `${first}^{tree}`),
    );
    expect(result && outcome(result)).toEqual({
      created: true,
      ref,
      commit: reminted,
      source: fx.mergeSha,
      pruned: [],
      latest: { sha: pb, changed: false },
    });
    expect(pushes).toEqual([createOf(reminted, ref)]);
  });

  test.each(PERMANENT)(
    "%s fails the tag push for good after every attempt (a refusal with the ref absent looks like a rival's create-and-prune), with git's own words, and nothing reaches origin",
    (_name, stderr) => {
      const fx = seedFixture();
      const ref = buildTagOf(fx, fx.mergeSha);
      const fail = { fail: { stderr, status: 128 } };
      let error: unknown;
      const pushes = withPushPlans(fx, [fail, fail, fail], () => {
        try {
          packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
        } catch (thrown) {
          error = thrown;
        }
      });
      const attempted = pushes.map(createdSha);
      expect(pushes).toEqual(attempted.map((sha) => createOf(sha, ref)));
      expect(attempted).toHaveLength(3);
      for (const sha of attempted) {
        expect(parentsOf(fx.work, sha)).toEqual([fx.mergeSha]);
      }
      expect(error).toEqual(
        new Error(`git push origin ${attempted[2]}:${ref} failed: ${stderr.trim()}`),
      );
      expect(buildTags(fx)).toEqual([]);
      expect(remoteRef(fx, LATEST)).toBe("");
    },
  );

  test("a create refused while the ref reads absent (a rival created and pruned it in between) is tried again, and the retry lands", () => {
    const fx = seedFixture();
    const ref = buildTagOf(fx, fx.mergeSha);
    const stderr = PERMANENT[0]?.[1] ?? "";
    let result: ReturnType<typeof packageCommit> | undefined;
    const pushes = withPushPlans(fx, [{ fail: { stderr, status: 128 } }], () => {
      result = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha, runUrl: RUN_URL });
    });
    const packaged = packagedOf(fx, fx.mergeSha);
    expect(result && outcome(result)).toEqual({
      created: true,
      ref,
      commit: packaged,
      source: fx.mergeSha,
      pruned: [],
      latest: { sha: packaged, changed: true },
    });
    expect(pushes).toEqual([
      createOf(createdSha(pushes[0] ?? []), ref),
      createOf(packaged, ref),
      moveOf(LATEST, "", packaged),
    ]);
  });

  test.each(PERMANENT)(
    "%s fails the latest push for good, with git's own words, after the tag was minted",
    (_name, stderr) => {
      const fx = seedFixture();
      const ref = buildTagOf(fx, fx.mergeSha);
      let error: unknown;
      const pushes = withPushPlans(fx, [null, { fail: { stderr, status: 128 } }], () => {
        try {
          packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
        } catch (thrown) {
          error = thrown;
        }
      });
      const packaged = packagedOf(fx, fx.mergeSha);
      expect(pushes).toEqual([createOf(packaged, ref), moveOf(LATEST, "", packaged)]);
      expect(error).toEqual(
        new Error(
          `git push --force-with-lease=${LATEST}: origin ${packaged}:${LATEST} failed: ${stderr.trim()}`,
        ),
      );
      expect(remoteRef(fx, LATEST)).toBe("");
    },
  );

  test("a shallow checkout is refused before any verdict", () => {
    const fx = seedFixture();
    const dir = shallowClone(fx, "shallow");
    writeBuild(dir, "packaged-bundle-bytes-1\n");
    expect(() => packageCommit({ cwd: dir, sourceSha: fx.mergeSha })).toThrow(
      "package-commit needs the full history (fetch-depth: 0) and this checkout is shallow: the commit's position on main and whether latest's source lies on its history cannot be judged on a truncated one.",
    );
    expect(buildTags(fx)).toEqual([]);
  });

  test("a commit that never reached main is refused before any push", () => {
    const fx = seedFixture();
    const side = clone(fx.root, fx.origin, "side");
    git(side, "checkout", "--quiet", "-b", "side", fx.seedSha);
    write(side, "src/marker.ts", "export const marker = 'side';\n");
    const sideSha = commitAll(side, "feat: never merged");
    git(side, "push", "--quiet", "origin", "HEAD:refs/heads/side");
    writeBuild(side, "packaged-bundle-bytes-1\n");
    const pushes = withPushPlans(fx, [], () => {
      expect(() => packageCommit({ cwd: side, sourceSha: sideSha })).toThrow(
        `${sideSha} is not on origin's main (its head is ${fx.mergeSha}); refusing to package a commit main does not hold.`,
      );
    });
    expect(pushes).toEqual([]);
    expect(buildTags(fx)).toEqual([]);
  });

  test("the eleventh green commit prunes the oldest tag; a release tag keeps its commit, a pruned release re-mints its package and prunes it at once, and the major moves forward only", () => {
    const fx = seedFixture();
    // Position 2 is released before the window fills; position 3 is a release merge post-green packaged but the
    // release hook never ran for.
    const release = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const later = clone(fx.root, fx.origin, "later-release");
    write(later, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.1.1" }, null, 2)}\n`);
    write(later, "package.json", manifestJson("2.1.1"));
    const laterMerge = commitAll(later, "chore(main): release 2.1.1 (#44)");
    git(later, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    writeBuild(later, "packaged-bundle-bytes-2\n");
    const laterPackaged = packageCommit({ cwd: later, sourceSha: laterMerge }).commit;
    const greens: { dir: string; sha: string }[] = [];
    for (let n = 1; n < KEPT_BUILD_TAGS; n++) {
      greens.push(pushGreenCommit(fx, `green-${n}`, `packaged-bundle-bytes-${n + 2}\n`));
    }
    const results = greens.map((green) => packageCommit({ cwd: green.dir, sourceSha: green.sha }));
    // Eleven tags before the last run's prune, ten after it: the release's went, the packaged merge's stays.
    expect(results.map((result) => result.pruned)).toEqual([
      ...greens.slice(0, -1).map(() => []),
      [buildTagOf(fx, fx.mergeSha)],
    ]);
    const newest = greens.at(-1) ?? { dir: "", sha: "" };
    const latestAt = packagedOf(fx, newest.sha);
    expect(buildTags(fx).sort()).toEqual(
      [buildTagOf(fx, laterMerge), ...greens.map((green) => buildTagOf(fx, green.sha))].sort(),
    );
    expect(originHolds(fx, release.packagedSha)).toBe(true);
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(release.packagedSha);
    expect(latestTag(fx)).toBe(latestAt);

    // The released commit's rerun finds its version tag and holds it to the build: no build tag is minted again.
    const rerun = checkoutOf(fx, "release-rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let verifiedRelease: ReturnType<typeof packageRelease> | undefined;
    const rerunPushes = withPushPlans(fx, [], () => {
      verifiedRelease = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(verifiedRelease).toMatchObject({
      created: false,
      packagedSha: release.packagedSha,
      pruned: [],
      latest: { sha: latestAt, changed: false },
    });
    expect(rerunPushes).toEqual([]);

    // One more green prunes the 2.1.1 merge's tag; its release hook then mints the package again, tags it, prunes
    // the fresh tag at once (the version tag keeps the commit), and moves the major forward; a rerun of 2.1.0's
    // major step leaves it there.
    const eleventh = pushGreenCommit(fx, "green-11", "packaged-bundle-bytes-13\n");
    expect(packageCommit({ cwd: eleventh.dir, sourceSha: eleventh.sha }).pruned).toEqual([
      buildTagOf(fx, laterMerge),
    ]);
    const hook = checkoutOf(fx, "later-hook", laterMerge, "packaged-bundle-bytes-2\n");
    let reminted: ReturnType<typeof packageRelease> | undefined;
    const hookPushes = withPushPlans(fx, [], () => {
      reminted = packageRelease({
        cwd: hook,
        tag: "v2.1.1",
        sourceSha: laterMerge,
        runUrl: RUN_URL,
      });
    });
    const remintedSha = reminted?.packagedSha ?? "";
    expect(remintedSha).not.toBe(laterPackaged);
    expect(git(hook, "rev-parse", `${remintedSha}^{tree}`)).toBe(
      git(hook, "rev-parse", `${laterPackaged}^{tree}`),
    );
    expect(reminted).toMatchObject({
      created: true,
      pruned: [buildTagOf(fx, laterMerge)],
      latest: { sha: packagedOf(fx, eleventh.sha), changed: false },
    });
    expect(hookPushes).toEqual([
      createOf(remintedSha, buildTagOf(fx, laterMerge)),
      createOf(remintedSha, "refs/tags/v2.1.1"),
      deleteOf(buildTagOf(fx, laterMerge)),
    ]);
    expect(buildTags(fx).sort()).toEqual(
      [...greens.map((green) => buildTagOf(fx, green.sha)), buildTagOf(fx, eleventh.sha)].sort(),
    );
    expect(originHolds(fx, remintedSha)).toBe(true);
    expect(retagMajor({ cwd: hook, tag: "v2.1.1", sourceSha: laterMerge }).move).toMatchObject({
      sha: remintedSha,
      changed: true,
    });
    expect(retagMajor({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha }).move).toMatchObject({
      sha: remintedSha,
      changed: false,
    });
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(remintedSha);
  });

  test("a legacy latest on the retired build chain is replaced, and the chain is never touched", async () => {
    const fx = seedFixture();
    // The chain as the pipeline left it: a root packaging the seed with a Source trailer, its child packaging the
    // merge commit, build at the child and latest on it.
    const root = plantCommit(
      fx,
      "chain-root",
      fx.seedSha,
      null,
      builtFiles("packaged-bundle-bytes-0\n"),
      ["build: main at seed", `Source: ${fx.seedSha}`],
    );
    git(root.from, "push", "--quiet", "origin", `${root.sha}:refs/heads/build`);
    const tip = plantCommit(
      fx,
      "chain-tip",
      fx.mergeSha,
      root.sha,
      builtFiles("packaged-bundle-bytes-1\n"),
      ["build: main at merge", `Source: ${fx.mergeSha}`],
    );
    git(
      tip.from,
      "push",
      "--quiet",
      "origin",
      `${tip.sha}:refs/heads/build`,
      `${tip.sha}:${LATEST}`,
    );
    const ref = buildTagOf(fx, fx.mergeSha);
    const run = await subcommand(
      fx.work,
      { GITHUB_SHA: fx.mergeSha, RUN_URL: undefined },
      "package-commit",
    );
    const packaged = packagedOf(fx, fx.mergeSha);
    // git's own push progress precedes the report on stderr.
    expect({ ...run, stderr: run.stderr.trimEnd().split("\n").at(-1) }).toEqual({
      stdout: "",
      stderr: `${ref}: created at ${packaged}; no build tag beyond the window; ${LATEST}: moved to ${packaged} from ${tip.sha}`,
      status: 0,
    });
    expect(latestTag(fx)).toBe(packaged);
    expect(git(fx.origin, "rev-parse", "refs/heads/build")).toBe(tip.sha);
    expect(parentsOf(fx.origin, packaged)).toEqual([fx.mergeSha]);
  });
});

describe("movePointer", () => {
  const V2 = "refs/tags/v2";

  test("a pointer at a bare main commit is read as packaging that commit's parent: a package of a descendant moves it, one of its parent is left, and one of its own source is refused as no package", () => {
    const fx = seedFixture();
    // v2 as the pipeline left it before it packaged commits: on a main commit that committed the bundle itself.
    git(fx.work, "push", "--quiet", "origin", `${fx.mergeSha}:${V2}`);
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const newer = packageCommit({ cwd: next.dir, sourceSha: next.sha });
    const older = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
    let move: ReturnType<typeof movePointer> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      move = movePointer(fx.work, V2, newer);
    });
    expect(move).toMatchObject({ ref: V2, sha: newer.commit, changed: true });
    expect(pushes).toEqual([moveOf(V2, fx.mergeSha, newer.commit)]);
    expect(git(fx.origin, "rev-parse", `${V2}^{}`)).toBe(newer.commit);
    expect(movePointer(fx.work, V2, older)).toMatchObject({
      ref: V2,
      sha: newer.commit,
      changed: false,
    });
    // The seed is v2's own source under that reading, so the value would be kept, and a kept value must be a
    // package, which a bare main commit is not.
    git(fx.work, "push", "--quiet", "--force", "origin", `${fx.mergeSha}:${V2}`);
    const seedRun = checkoutOf(fx, "seed-run", fx.seedSha, "packaged-bundle-bytes-0\n");
    const seedPackage = packageCommit({ cwd: seedRun, sourceSha: fx.seedSha });
    expect(() => movePointer(fx.work, V2, seedPackage)).toThrow(
      new RegExp(
        `^${V2} \\(${fx.mergeSha}\\) is not ${fx.seedSha} plus lib/index\\.js, lib/settings\\.schema\\.json, and lib/pkg/, minus package\\.json's preparation scripts, alone: .*; inspect it by hand\\.$`,
      ),
    );
  });

  test("a pointer at another commit of the same package is left there; one at another build of the same commit is refused", () => {
    const fx = seedFixture();
    const first = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
    // The same package minted again (another run URL), and a build of the same commit that differs.
    const again = plantCommit(
      fx,
      "again",
      fx.mergeSha,
      fx.mergeSha,
      builtFiles("packaged-bundle-bytes-1\n"),
      ["build: main at merge", "Workflow-run: https://example.invalid/actions/runs/8"],
    );
    const other = rivalPackage(fx, "other-build", fx.mergeSha, "DIFFERENT-bytes\n");
    git(again.from, "push", "--quiet", "origin", `${again.sha}:refs/heads/again`);
    git(other.from, "push", "--quiet", "origin", `${other.sha}:refs/heads/other`);
    git(fx.work, "fetch", "--quiet", "origin", "refs/heads/again", "refs/heads/other");
    expect(again.sha).not.toBe(first.commit);
    let left: ReturnType<typeof movePointer> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      left = movePointer(fx.work, LATEST, { commit: again.sha, source: fx.mergeSha });
      expect(() =>
        movePointer(fx.work, LATEST, { commit: other.sha, source: fx.mergeSha }),
      ).toThrow(
        `${LATEST} is at ${first.commit}, another package of ${fx.mergeSha} than ${other.sha} with another tree; two builds of one main commit exist - inspect both by hand.`,
      );
    });
    expect(left).toMatchObject({ ref: LATEST, sha: first.commit, changed: false });
    expect(pushes).toEqual([]);
    expect(latestTag(fx)).toBe(first.commit);
  });

  test("an annotated pointer is leased by its tag object, not the commit it peels to", () => {
    const fx = seedFixture();
    const older = packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha }).commit;
    git(fx.work, "tag", "-a", "-f", "-m", "by hand", "latest", older);
    git(fx.work, "push", "--quiet", "--force", "origin", LATEST);
    const tagObject = git(fx.origin, "rev-parse", LATEST);
    expect(tagObject).not.toBe(older);
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    let result: ReturnType<typeof packageCommit> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageCommit({ cwd: next.dir, sourceSha: next.sha });
    });
    const packaged = packagedOf(fx, next.sha);
    expect(result?.latest).toMatchObject({ sha: packaged, changed: true });
    expect(pushes).toEqual([
      createOf(packaged, buildTagOf(fx, next.sha)),
      moveOf(LATEST, tagObject, packaged),
    ]);
    expect(latestTag(fx)).toBe(packaged);
  });
});

describe("pruneBuildTags", () => {
  /** Positions 1..count, one tag each, all on the seed commit: the prune reads names, not commits. */
  function plantWindow(fx: Fixture, count = 12): { refs: string[]; first: string; second: string } {
    const refs = Array.from(
      { length: count },
      (_, n) => `refs/tags/build/${n + 1}.${fx.seedSha.slice(0, 7)}`,
    );
    git(fx.work, "push", "--quiet", "origin", ...refs.map((ref) => `${fx.seedSha}:${ref}`));
    return { refs, first: refs[0] ?? "", second: refs[1] ?? "" };
  }

  test("the tags beyond the ten newest by position are deleted in one push; a window within the bound is left alone", () => {
    const fx = seedFixture();
    const { refs, first, second } = plantWindow(fx);
    let deleted: string[] | undefined;
    const pushes = withPushPlans(fx, [], () => {
      deleted = pruneBuildTags(fx.work);
    });
    expect(deleted).toEqual([second, first]);
    expect(pushes).toEqual([deleteOf(second, first)]);
    expect(buildTags(fx).sort()).toEqual(refs.slice(2).sort());
    const again = withPushPlans(fx, [], () => {
      expect(pruneBuildTags(fx.work)).toEqual([]);
    });
    expect(again).toEqual([]);
  });

  test("a rival deleting a candidate between the list and the push does not fail the push: git warns on the vanished ref, the fact the prune relies on", () => {
    const fx = seedFixture();
    const { refs, first, second } = plantWindow(fx);
    // The marker proves the rival ran before the push; the push landing with the ref gone is the fact under test.
    const marker = join(fx.root, "rival-deleted-first");
    let deleted: string[] | undefined;
    const pushes = withPushPlans(
      fx,
      [{ script: `git -C "${fx.origin}" update-ref -d ${first} && : > "${marker}"\n` }],
      () => {
        deleted = pruneBuildTags(fx.work);
      },
    );
    expect(existsSync(marker)).toBe(true);
    expect(deleted).toEqual([second, first]);
    expect(pushes).toEqual([deleteOf(second, first)]);
    expect(buildTags(fx).sort()).toEqual(refs.slice(2).sort());
  });

  test("a ref under build/ this pipeline would not name stops the prune", () => {
    const fx = seedFixture();
    plantWindow(fx, 3);
    git(fx.work, "push", "--quiet", "origin", `${fx.seedSha}:refs/tags/build/by-hand`);
    const pushes = withPushPlans(fx, [], () => {
      expect(() => pruneBuildTags(fx.work)).toThrow(
        "origin holds refs/tags/build/by-hand, which is not a build/<position>.<sha7> tag this pipeline names; delete it by hand.",
      );
    });
    expect(pushes).toEqual([]);
  });

  test.each(PERMANENT)(
    "%s fails the delete push for good, with git's own words",
    (_name, stderr) => {
      const fx = seedFixture();
      const { refs, first, second } = plantWindow(fx);
      let error: unknown;
      const pushes = withPushPlans(fx, [{ fail: { stderr, status: 128 } }], () => {
        try {
          pruneBuildTags(fx.work);
        } catch (thrown) {
          error = thrown;
        }
      });
      expect(pushes).toEqual([deleteOf(second, first)]);
      expect(error).toEqual(
        new Error(`git push origin :${second} :${first} failed: ${stderr.trim()}`),
      );
      expect(buildTags(fx).sort()).toEqual(refs.sort());
    },
  );
});
