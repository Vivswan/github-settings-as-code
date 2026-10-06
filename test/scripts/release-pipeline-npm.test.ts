/**
 * The npm side of the release pipeline against the fixture repositories and a registry served from the test process:
 * the pre-release version a main commit mints, the publish verdicts and the confirmation, the npm-publish step, and
 * the npm floor.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MainPosition, mainPosition } from "../../.github/scripts/release-pipeline/git.js";
import {
  type NextVerdict,
  nextPublishVerdict,
  npmConfirm,
  npmVerdict,
  type Packument,
  type PublishVerdict,
  prereleaseVersion,
  prereleaseVersionOf,
  stablePublishVerdict,
} from "../../.github/scripts/release-pipeline/npm.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";
import {
  checkoutOf,
  clone,
  commitAll,
  type Fixture,
  git,
  installReleasePipelineFixture,
  pushGreenCommit,
  seedFixture,
  shallowClone,
  subcommand,
  write,
} from "./release-pipeline-fixture.js";

// Dozens of git spawns per test time out bun's 5s default under parallel machine load.
setDefaultTimeout(60_000);
installReleasePipelineFixture();

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
      stderr: "GITHUB_SHA must be set for this step\n",
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

  /** The fixture's published version, and an ancestor's pre-release next named before it. */
  const published = (fx: Fixture) => versionOf(fx.work, fx.mergeSha, 2);
  const older = (fx: Fixture) => versionOf(fx.work, fx.seedSha, 1);
  /** A descendant's pre-release: main grew one commit past the source, fetched into the work clone. */
  function newer(fx: Fixture): string {
    const after = pushGreenCommit(fx, "after", "packaged-bundle-bytes-2\n");
    git(fx.work, "fetch", "--quiet", "origin");
    return versionOf(fx.work, after.sha, 3);
  }
  /** The drift the confirmation reports when next stayed on this run's version while a descendant's is on the record. */
  const behind = (fx: Fixture, ahead: string): string =>
    `the registry's next is ${published(fx)} while it holds ${ahead}, whose source ${ahead.slice(-7)} is a descendant ` +
    `of ${fx.mergeSha.slice(0, 7)} on main; this stale run moved next back, and the next release-PR refresh moves it forward ` +
    `(npm dist-tag add @scope/pkg@${ahead} next repairs it by hand)`;

  describe("npm-confirm after a next publish", () => {
    const confirm = (fx: Fixture, registry: string, attempts = 5) =>
      npmConfirm({ cwd: fx.work, sourceSha: fx.mergeSha, registry, attempts, delayMs: 0 });

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
  });

  describe("the npm-publish subcommand", () => {
    /** An npm first on PATH that prints every call with the GITHUB_SHA it saw and, when told, fails one command. */
    function withNpm<T>(
      body: (path: string) => Promise<T>,
      failing?: { command: string; status: number },
    ): Promise<T> {
      return withTempDir("npm-publish-stub-", (dir) => {
        writeFileSync(
          join(dir, "npm"),
          [
            "#!/bin/sh",
            'echo "npm $* (GITHUB_SHA=$GITHUB_SHA)"',
            ...(failing === undefined
              ? []
              : [`[ "$1" = "${failing.command}" ] && exit ${failing.status}`]),
            "exit 0",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        return body(`${dir}:${process.env.PATH ?? ""}`);
      });
    }
    /** The step's environment: the source, the local registry, the stub npm, no pause between the confirmation's reads. */
    const env = (fx: Fixture, url: string, path: string) => ({
      GITHUB_SHA: fx.mergeSha,
      TAG: "v2.1.0",
      NPM_REGISTRY_URL: url,
      NPM_CONFIRM_PAUSE_MS: "0",
      PATH: path,
    });
    /** The npm calls a publish makes, as the stub reports them: every call sees the source, the publish names it. */
    const nextPublish = (fx: Fixture, own: string): string =>
      [
        `npm version ${own} --no-git-tag-version (GITHUB_SHA=${fx.mergeSha})`,
        `npm pkg delete scripts.prepare (GITHUB_SHA=${fx.mergeSha})`,
        `npm publish --tag next (GITHUB_SHA=${fx.mergeSha})`,
        "",
      ].join("\n");
    const stablePublish = (fx: Fixture): string =>
      [
        `npm pkg delete scripts.prepare (GITHUB_SHA=${fx.mergeSha})`,
        `npm publish (GITHUB_SHA=${fx.mergeSha})`,
        "",
      ].join("\n");
    const run = (fx: Fixture, url: string, path: string, channel: string) =>
      subcommand(fx.work, env(fx, url, path), "npm-publish", channel);

    test(
      "next: a publish verdict sets the version, drops scripts.prepare, publishes under next, then holds the lane " +
        "until the record shows the version; the verdict's notices go to stderr",
      async () => {
        const fx = seedFixture();
        const own = published(fx);
        const unresolved = "2.1.1-main.9.20260901.g0000000";
        const judged = registry(["2.1.0", unresolved], { latest: "2.1.0", next: unresolved });
        const lagging = registry(["2.1.0", older(fx)], { latest: "2.1.0", next: older(fx) });
        const converged = registry(["2.1.0", own], { latest: "2.1.0", next: own });
        const started = performance.now();
        const result = await withNpm((path) =>
          withRegistry(
            [
              { status: 200, body: judged },
              { status: 200, body: lagging },
              { status: 200, body: converged },
            ],
            async (url, requests) => ({ step: await run(fx, url, path, "next"), requests }),
          ),
        );
        expect(result.step).toEqual({
          stdout:
            `${nextPublish(fx, own)}::notice::${own} is on the registry after 2 reads; ` +
            "next is not behind a descendant's pre-release\n",
          stderr: `${unresolved} names 0000000, which is no commit in this checkout; ignored\n`,
          status: 0,
        });
        // One read for the verdict, two for the confirmation; the bound is the control: a run that ignored
        // NPM_CONFIRM_PAUSE_MS would pause 20 s between those two.
        expect(result.requests).toHaveLength(3);
        expect(performance.now() - started).toBeLessThan(10_000);
      },
    );

    test.each<[string, (fx: Fixture) => { record: Packument; reason: string }]>([
      [
        "a rerun whose version the record holds",
        (fx) => ({
          record: registry(["2.1.0", published(fx)], { latest: "2.1.0", next: published(fx) }),
          reason: `${published(fx)} is already on the registry`,
        }),
      ],
      [
        "a stale run behind a descendant's pre-release",
        (fx) => {
          const ahead = newer(fx);
          return {
            record: registry(["2.1.0", ahead], { latest: "2.1.0", next: ahead }),
            reason:
              `the registry already holds ${ahead}, whose source ${ahead.slice(-7)} is a descendant of ` +
              `${fx.mergeSha.slice(0, 7)} on main, so this stale run publishes nothing (npm publish --tag next ` +
              "would move next back)",
          };
        },
      ],
    ])("next: %s calls npm not at all and raises a notice", async (_name, state) => {
      const fx = seedFixture();
      const { record, reason } = state(fx);
      const step = await withNpm((path) =>
        withRegistry({ status: 200, body: record }, (url) => run(fx, url, path, "next")),
      );
      expect(step).toEqual({ stdout: `::notice::${reason}\n`, stderr: "", status: 0 });
    });

    test("next: a record that never shows the version within the bound warns, and the step passes", async () => {
      const fx = seedFixture();
      const own = published(fx);
      const lagging = registry(["2.1.0", older(fx)], { latest: "2.1.0", next: older(fx) });
      const result = await withNpm((path) =>
        withRegistry([{ status: 404 }, { status: 200, body: lagging }], async (url, requests) => ({
          step: await run(fx, url, path, "next"),
          requests,
        })),
      );
      expect(result.step).toEqual({
        stdout:
          `${nextPublish(fx, own)}::warning::the registry's record still lacks ${own} after 15 reads over 0 s; ` +
          "a run judged before it shows may move next back, and the release-PR refresh after it moves next forward\n",
        stderr: "",
        status: 0,
      });
      expect(result.requests).toHaveLength(16);
    });

    test("next: next left behind a descendant's pre-release fails the step with the drift named, after the publish", async () => {
      const fx = seedFixture();
      const own = published(fx);
      const ahead = newer(fx);
      const drifted = registry(["2.1.0", ahead, own], { latest: "2.1.0", next: own });
      const step = await withNpm((path) =>
        withRegistry([{ status: 404 }, { status: 200, body: drifted }], (url) =>
          run(fx, url, path, "next"),
        ),
      );
      expect(step).toEqual({
        stdout: `${nextPublish(fx, own)}::error::${behind(fx, ahead)}\n`,
        stderr: "",
        status: 1,
      });
    });

    test("next: an npm publish that fails ends the step with its status named, after the verdict's notices, and nothing confirms", async () => {
      const fx = seedFixture();
      const unresolved = "2.1.1-main.9.20260901.g0000000";
      const judged = registry(["2.1.0", unresolved], { latest: "2.1.0", next: unresolved });
      const result = await withNpm(
        (path) =>
          withRegistry({ status: 200, body: judged }, async (url, requests) => ({
            step: await run(fx, url, path, "next"),
            requests,
          })),
        { command: "publish", status: 3 },
      );
      expect(result.step).toEqual({
        stdout: nextPublish(fx, published(fx)),
        stderr:
          `${unresolved} names 0000000, which is no commit in this checkout; ignored\n` +
          "release-pipeline npm-publish: npm publish --tag next exited 3; see npm's output above.\n",
        status: 1,
      });
      expect(result.requests).toHaveLength(1);
    });

    test.each<[string, Packument | null, string]>([
      [
        "a publish verdict drops scripts.prepare and publishes under the default dist-tag",
        null,
        "",
      ],
      [
        "a skip verdict calls npm not at all and warns",
        { versions: { "2.1.0": {} }, "dist-tags": { latest: "2.1.0" } },
        "::warning::2.1.0 is already on the registry\n",
      ],
    ])("stable: %s", async (_name, record, annotation) => {
      const fx = seedFixture();
      const result = await withNpm((path) =>
        withRegistry(
          record === null ? { status: 404 } : { status: 200, body: record },
          async (url, requests) => ({ step: await run(fx, url, path, "stable"), requests }),
        ),
      );
      expect(result.step).toEqual({
        stdout: record === null ? stablePublish(fx) : annotation,
        stderr: "",
        status: 0,
      });
      // A release confirms nothing: one read, for the verdict.
      expect(result.requests).toHaveLength(1);
    });

    test.each<[string, string[], Record<string, string | undefined>, string]>([
      [
        "no channel",
        [],
        {},
        "release-pipeline npm-publish: npm-publish takes the channel, next or stable, not null",
      ],
      [
        "a release without its tag",
        ["stable"],
        { TAG: undefined },
        "TAG must be set for this step",
      ],
      [
        "a pause that is not a whole number of milliseconds",
        ["next"],
        { NPM_CONFIRM_PAUSE_MS: "soon" },
        'release-pipeline npm-publish: NPM_CONFIRM_PAUSE_MS must be a whole number of milliseconds, not "soon"',
      ],
    ])(
      "%s is refused before the registry is read or npm runs",
      async (_name, args, override, stderr) => {
        const fx = seedFixture();
        const asked = await withNpm((path) =>
          withRegistry({ status: 404 }, async (url, requests) => {
            expect(
              await subcommand(
                fx.work,
                { ...env(fx, url, path), ...override },
                "npm-publish",
                ...args,
              ),
            ).toEqual({
              stdout: "",
              stderr: `${stderr}\n`,
              status: 1,
            });
            return requests;
          }),
        );
        expect(asked).toEqual([]);
      },
    );
  });
});

describe("npmFloor", () => {
  /** A scripted npm first on PATH: `--version` prints the version file, `install -g npm@latest` logs itself and
   * replaces that file with the planned upgrade, or exits with the planned status when the plan says `fail <n>`. */
  function withNpm(dir: string, version: string, after: string): string {
    writeFileSync(join(dir, "version"), `${version}\n`);
    writeFileSync(join(dir, "after"), `${after}\n`);
    writeFileSync(
      join(dir, "npm"),
      [
        "#!/bin/sh",
        `here="${dir}"`,
        'if [ "$1" = "--version" ]; then cat "$here/version"; exit 0; fi',
        'printf "%s\\n" "$*" >> "$here/calls.log"',
        'read -r kind code < "$here/after"',
        'if [ "$kind" = "fail" ]; then exit "$code"; fi',
        'cp "$here/after" "$here/version"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return dir;
  }
  const installs = (dir: string): string[] =>
    existsSync(join(dir, "calls.log"))
      ? readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean)
      : [];

  test.each([
    ["at the floor", "11.5.1", "11.5.1", 0, [], "", ""],
    [
      "above it by a two-digit minor (numeric, not textual, order)",
      "11.10.0",
      "11.10.0",
      0,
      [],
      "",
      "",
    ],
    [
      "below it, with an upgrade that reaches it",
      "10.9.2",
      "11.6.0",
      0,
      ["install -g npm@latest"],
      "",
      "",
    ],
    [
      "below it, with an upgrade that does not",
      "10.9.2",
      "10.9.2",
      1,
      ["install -g npm@latest"],
      "::error::npm 10.9.2 cannot publish through OIDC; trusted publishing needs npm 11.5.1 or newer.\n",
      "",
    ],
    [
      "below it, with an upgrade that fails",
      "10.9.2",
      "fail 7",
      1,
      ["install -g npm@latest"],
      "",
      "release-pipeline npm-floor: npm 10.9.2 is below 11.5.1 and npm install -g npm@latest exited 7; the publish needs npm 11.5.1 or newer.\n",
    ],
    [
      "at a prerelease of the floor, with an upgrade that still prints no version",
      "11.5.1-pre.0",
      "not-a-version",
      1,
      ["install -g npm@latest"],
      "::error::npm not-a-version cannot publish through OIDC; trusted publishing needs npm 11.5.1 or newer.\n",
      "",
    ],
  ])(
    "an npm %s: the upgrade runs once at most, the floor holding is silent, and the floor failing is the annotation",
    (_, version, after, status, upgrades, stdout, stderr) =>
      withTempDir("npm-floor-", async (dir) => {
        const npm = withNpm(dir, version, after);
        expect(
          await subcommand(ROOT, { PATH: `${npm}:${process.env.PATH ?? ""}` }, "npm-floor"),
        ).toEqual({ stdout, stderr, status });
        expect(installs(npm)).toEqual(upgrades);
      }),
  );
});
