/**
 * The release pipeline proven against local fixture repositories: a bare
 * "origin" plus clones playing the CI checkouts, so "the next release puts
 * vX.Y.Z and the major on the build branch's commit for the merge commit"
 * is a unit test, not something the first real release discovers. Covers
 * the packaged-commit topology (the build chain's parents, tree, bundle
 * bytes, the carries-a-bundle invariant), idempotent reruns that verify
 * instead of move, the tamper stops, the major move, the boundary anchor,
 * the moving latest tag, and the one push-failure classification every
 * retrying push goes through.
 *
 * Every push in this file runs through a git shim first on PATH: it refuses
 * a push whose working directory is not inside a fixture (so a helper called
 * without cwd can never reach the real origin) and, inside withPushPlans,
 * logs each push and plays a rival or a scripted remote failure ahead of it.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  advanceBuild,
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

/** Where every fixture lives: mkdtemp under the temp dir with this prefix,
 * resolved to its physical path (the shim compares against `pwd -P`). */
const FIXTURE_AREA = realpathSync(tmpdir());
const FIXTURE_PREFIX = "release-pipeline-";
const PLANS_ENV = "RELEASE_PIPELINE_PUSH_PLANS";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The shim's refusal, as it prints it. */
function guardRefusal(cwd: string): string {
  return `release-pipeline fixture guard: refusing git push from ${cwd}, which is not inside ${FIXTURE_AREA}/${FIXTURE_PREFIX}*/`;
}

/** Install the git shim first on PATH for the whole file: the real git for
 * everything but push; a push is refused outside the fixture area, and when
 * ${PLANS_ENV} names a plans directory it is logged there and its plan (by
 * ordinal; none lets it through) runs first. */
let shimDir = "";
/** PATH as it was before the shim went first; undefined until it did. */
let realPath: string | undefined;
/** The real git, for a scripted rival that must not be logged as one of the pipeline's pushes. */
let realGit = "";
beforeAll(() => {
  realGit = Bun.which("git") ?? "";
  if (realGit === "") {
    throw new Error("no git on PATH");
  }
  shimDir = mkdtempSync(join(tmpdir(), "release-pipeline-shim-"));
  const script = [
    "#!/bin/sh",
    `if [ "$1" != "push" ]; then exec "${realGit}" "$@"; fi`,
    'here="$(pwd -P)"',
    'case "$here/" in',
    `  "${FIXTURE_AREA}"/${FIXTURE_PREFIX}*/*) ;;`,
    `  *) echo "release-pipeline fixture guard: refusing git push from $here, which is not inside ${FIXTURE_AREA}/${FIXTURE_PREFIX}*/" >&2; exit 1 ;;`,
    "esac",
    `plans="$${PLANS_ENV}"`,
    'if [ -n "$plans" ]; then',
    `  printf '%s\\n' "$*" >> "$plans/pushes.log"`,
    `  n=$(wc -l < "$plans/pushes.log" | tr -d ' ')`,
    '  plan="$plans/$n"',
    '  if [ -f "$plan" ]; then',
    '    read -r kind a b c < "$plan"',
    '    case "$kind" in',
    `      competitor) "${realGit}" -C "$a" push --quiet --force origin "$b:$c" ;;`,
    '      fail) cat "$plan.stderr" >&2; exit "$a" ;;',
    '      script) sh "$plan.sh" ;;',
    "    esac",
    "  fi",
    "fi",
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(shimDir, "git"), script, { mode: 0o755 });
  realPath = process.env.PATH ?? "";
  process.env.PATH = `${shimDir}:${realPath}`;
});
// Undo only what beforeAll got to: a setup failure must surface as itself,
// not as a cleanup of a PATH never changed or a directory never made.
afterAll(() => {
  if (realPath !== undefined) {
    process.env.PATH = realPath;
  }
  if (shimDir !== "") {
    rmSync(shimDir, { recursive: true, force: true });
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

/** Take the workflows directory out of a clone's index: what every
 * packaged tree lacks, so a planted chain commit deviates from the
 * pipeline's only where the test means it to. */
function stripWorkflows(cwd: string): void {
  git(cwd, "rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ".github/workflows");
}

/** Every path in a commit's tree. */
function treePaths(cwd: string, sha: string): string[] {
  return git(cwd, "ls-tree", "-r", "--name-only", sha).split("\n");
}

/** The paths a chain commit's diff against its source lists: the workflow removal and the bundle. */
const PACKAGED_DIFF = ".github/workflows/ci.yml\nlib/index.js";

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
  const root = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
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
  // A workflow (which no chain commit may carry) beside another .github
  // file (which every chain commit keeps).
  write(work, ".github/workflows/ci.yml", "name: ci\non: push\njobs: {}\n");
  write(work, ".github/dependabot.yml", "version: 2\nupdates: []\n");
  write(work, "src/marker.ts", "export const marker = 1;\n");
  const seedSha = commitAll(work, "chore: seed the fixture at the 2.0.0 release");
  write(work, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.1.0" }, null, 2)}\n`);
  write(work, "CHANGELOG.md", CHANGELOG_21);
  const mergeSha = commitAll(work, "chore(main): release 2.1.0 (#42)");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  write(work, "lib/index.js", "packaged-bundle-bytes-1\n");
  return { root, origin, work, seedSha, mergeSha };
}

/** A fresh CI checkout of `sha` with `bundle` "built" from it. */
function checkoutOf(fx: Fixture, name: string, sha: string, bundle: string): string {
  const dir = clone(fx.root, fx.origin, name);
  git(dir, "checkout", "--quiet", sha);
  write(dir, "lib/index.js", bundle);
  return dir;
}

/** A later green push to main, prepared as CI sees it: a fresh clone at
 * the new head with the bundle "built" from it. */
function pushGreenCommit(fx: Fixture, name: string, bundle: string): { dir: string; sha: string } {
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

/** The verify job's checkout: main's head at depth 1, made after main
 * moved past the merge commit, so the merge commit's tree is not local
 * and only the confirmation's own fetch can supply it. */
function shallowChecker(fx: Fixture, name: string): string {
  pushGreenCommit(fx, `${name}-after-release`, "packaged-bundle-bytes-9\n");
  const checker = join(fx.root, name);
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${fx.origin}`, checker]);
  let known = true;
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${fx.mergeSha}^{commit}`], {
      cwd: checker,
      stdio: "ignore",
    });
  } catch {
    known = false;
  }
  expect(known).toBe(false);
  return checker;
}

const buildTip = (fx: Fixture): string => git(fx.origin, "rev-parse", "refs/heads/build");
/** A commit's first parent as its object records it, whatever ref or
 * shallow state the clone reading it is in. */
const parentOf = (cwd: string, sha: string): string =>
  git(cwd, "cat-file", "-p", sha).match(/^parent ([0-9a-f]{40})$/m)?.[1] ?? "";
const latestTag = (fx: Fixture): string => git(fx.origin, "rev-parse", "refs/tags/latest^{}");
const remoteRef = (fx: Fixture, ref: string): string => git(fx.work, "ls-remote", "origin", ref);

/**
 * A commit shaped like the pipeline's chain commits but minted by another
 * writer: `source`'s tree minus workflows plus `bundle`, parented on `parent`
 * (null for the chain's first commit, a root like the pipeline's own), naming
 * `source` in a Source trailer. Not pushed; the clone holding it is returned
 * for a competitor plan to push from.
 */
function rivalChainCommit(
  fx: Fixture,
  name: string,
  source: string,
  parent: string | null,
  bundle: string,
): { from: string; sha: string } {
  const from = clone(fx.root, fx.origin, name);
  git(from, "checkout", "--quiet", source);
  stripWorkflows(from);
  write(from, "lib/index.js", bundle);
  git(from, "add", "-f", "lib/index.js");
  const tree = git(from, "write-tree");
  const sha = git(
    from,
    "commit-tree",
    tree,
    ...(parent === null ? [] : ["-p", parent]),
    "-m",
    "build: by another run",
    "-m",
    `Source: ${source}`,
  );
  return { from, sha };
}

/** What the shim does to the pipeline's n-th push, before real git sees it. */
type PushPlan =
  /** Force-push `sha` to `ref` first from the clone `from`; real git then judges the pipeline's push. */
  | { competitor: { from: string; sha: string; ref: string } }
  /** Run this shell first (a rival whose commit depends on origin's state at that moment). */
  | { script: string }
  /** Replay a remote a file:// origin cannot play: this stderr, this exit status. */
  | { fail: { stderr: string; status: number } };

/** Run `body` with the shim logging every push and playing `plans` by
 * ordinal (null lets that push through). Returns the push argument lists, in order. */
function withPushPlans(fx: Fixture, plans: (PushPlan | null)[], body: () => void): string[][] {
  const plansDir = mkdtempSync(join(fx.root, "push-plans-"));
  for (const [index, plan] of plans.entries()) {
    if (plan === null) {
      continue;
    }
    const file = join(plansDir, String(index + 1));
    if ("competitor" in plan) {
      const { from, sha, ref } = plan.competitor;
      writeFileSync(file, `competitor ${from} ${sha} ${ref}\n`);
    } else if ("script" in plan) {
      writeFileSync(file, "script\n");
      writeFileSync(`${file}.sh`, plan.script);
    } else {
      writeFileSync(file, `fail ${plan.fail.status}\n`);
      writeFileSync(`${file}.stderr`, plan.fail.stderr);
    }
  }
  const before = process.env[PLANS_ENV];
  process.env[PLANS_ENV] = plansDir;
  try {
    body();
  } finally {
    if (before === undefined) {
      delete process.env[PLANS_ENV];
    } else {
      process.env[PLANS_ENV] = before;
    }
  }
  // No log means no push was attempted; any other trouble reading it must
  // surface, or a no-push assertion could not tell the two apart.
  const log = join(plansDir, "pushes.log");
  if (!existsSync(log)) {
    return [];
  }
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" "));
}

const appendOf = (sha: string): string[] => ["push", "origin", `${sha}:refs/heads/build`];
const latestOf = (observed: string, tip: string): string[] => [
  "push",
  `--force-with-lease=refs/tags/latest:${observed}`,
  "origin",
  `${tip}:refs/tags/latest`,
];
const majorOf = (observed: string): string[] => [
  "push",
  `--force-with-lease=refs/tags/v2:${observed}`,
  "origin",
  "refs/tags/v2",
];
const TAG_PUSH = ["push", "origin", "refs/tags/v2.1.0"];
const ANCHOR_PUSH = ["push", "origin", "HEAD:refs/heads/release-please--branches--main"];
/** The commit a logged append carried (its objects exist in the pushing clone). */
const appendedSha = (push: string[]): string =>
  push.join(" ").replace(/^push origin (\w+):refs\/heads\/build$/, "$1");

/** Remotes a file:// origin cannot play, as git words them; none is a retry's to win. */
const PERMANENT: [string, string][] = [
  [
    "a token without write access",
    "remote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403\n",
  ],
  [
    "a ruleset declining the ref",
    "remote: error: GH013: Repository rule violations found for refs/heads/build.\nremote:\n" +
      "remote: - Cannot update this protected ref.\nremote:\nTo https://github.com/o/r.git\n" +
      " ! [remote rejected] 0123abc -> build (push declined due to repository rule violations)\n" +
      "error: failed to push some refs to 'https://github.com/o/r.git'\n",
  ],
  [
    "a hook quoting git's compare-and-set words on its own line",
    "remote: pre-receive hook declined: cannot lock ref 'refs/heads/build': reference already exists\n" +
      "To https://github.com/o/r.git\n ! [remote rejected] 0123abc -> build (pre-receive hook declined)\n" +
      "error: failed to push some refs to 'https://github.com/o/r.git'\n",
  ],
];

describe("the fixture push guard", () => {
  test("a push from outside the fixture area is refused before git runs (negative control)", () => {
    const outside = mkdtempSync(join(tmpdir(), "not-a-release-pipeline-fixture-"));
    roots.push(outside);
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
  });

  test("a push from inside a fixture lands (positive control)", () => {
    const fx = seedFixture();
    git(fx.work, "push", "--quiet", "origin", `${fx.seedSha}:refs/heads/control`);
    expect(git(fx.origin, "rev-parse", "refs/heads/control")).toBe(fx.seedSha);
  });
});

describe("packageRelease", () => {
  test("a fresh release with no build branch appends its chain commit, tags it, and a rerun verifies it", () => {
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
    const packaged = git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}");
    expect(result).toEqual({ created: true, packagedSha: packaged, latestSha: packaged });
    expect(pushes).toEqual([appendOf(packaged), TAG_PUSH, latestOf("", packaged)]);
    // The chain's first commit is a root (no parent: a child of the source
    // would record the workflow files' deletion, a workflow change the
    // default token may not push); the tag and latest sit on it, and so
    // does the major once it moves.
    expect(buildTip(fx)).toBe(packaged);
    expect(latestTag(fx)).toBe(packaged);
    retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(packaged);
    expect(parentOf(fx.origin, packaged)).toBe("");
    expect(git(fx.origin, "diff", "--name-only", fx.mergeSha, packaged)).toBe(PACKAGED_DIFF);
    expect(treePaths(fx.origin, packaged)).toEqual([
      ".github/dependabot.yml",
      ".gitignore",
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "lib/index.js",
      "release-please-config.json",
      "src/marker.ts",
    ]);
    expect(git(fx.origin, "show", `${packaged}:lib/index.js`)).toBe("packaged-bundle-bytes-1");
    const body = git(fx.origin, "log", "-1", "--format=%B", packaged);
    expect(body).toContain(`build: main at ${git(fx.origin, "rev-parse", "--short", fx.mergeSha)}`);
    expect(body).toContain("Workflow-run: https://example.invalid/actions/runs/1");
    expect(sourceTrailer(fx.origin, packaged)).toBe(fx.mergeSha);

    // Idempotent rerun: a fresh checkout that rebuilt the same bytes
    // verifies the existing tag instead of recreating or moving it.
    const rerun = checkoutOf(fx, "rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let verified: ReturnType<typeof packageRelease> | undefined;
    const rerunPushes = withPushPlans(fx, [], () => {
      verified = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(verified).toEqual({ created: false, packagedSha: packaged, latestSha: packaged });
    expect(rerunPushes).toEqual([]);
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(packaged);
    expect(buildTip(fx)).toBe(packaged);
  });

  test("a release whose chain commit post-green already appended is tagged there, with no second append", () => {
    const fx = seedFixture();
    const chain = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
    const release = checkoutOf(fx, "release", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: release, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    // latest already sits where post-green put it, so no lease push.
    expect(result).toEqual({ created: true, packagedSha: chain, latestSha: chain });
    expect(pushes).toEqual([TAG_PUSH]);
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(chain);
    expect(buildTip(fx)).toBe(chain);
  });

  test("a release whose chain commit lies behind newer green commits is found on the chain", () => {
    const fx = seedFixture();
    const chain = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const tip = advanceBuild({ cwd: next.dir, sourceSha: next.sha }).buildSha;
    const release = checkoutOf(fx, "release", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: release, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    // latest names the newer commit and stays there.
    expect(result).toEqual({ created: true, packagedSha: chain, latestSha: tip });
    expect(pushes).toEqual([TAG_PUSH]);
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(chain);
    expect(buildTip(fx)).toBe(tip);
    expect(latestTag(fx)).toBe(tip);
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
    const packaged = git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}");
    expect(pushes).toEqual([appendOf(packaged), TAG_PUSH, latestOf("", packaged)]);
    expect(error).toEqual(
      new Error(
        `git push --force-with-lease=refs/tags/latest: origin ${packaged}:refs/tags/latest failed: ${stderr.trim()}`,
      ),
    );
    expect(remoteRef(fx, "refs/tags/latest")).toBe("");
    // The rerun verifies the tag, then moves latest.
    const rerun = checkoutOf(fx, "rerun-heal", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const rerunPushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(result).toEqual({ created: false, packagedSha: packaged, latestSha: packaged });
    expect(rerunPushes).toEqual([latestOf("", packaged)]);
    expect(latestTag(fx)).toBe(packaged);
  });

  test("a rerun of a release whose chain commit is followed by a backfill of an older source judges the backfill on main's full history", () => {
    const fx = seedFixture();
    // main: seed -> merge -> next. build: P(merge) with the tag, Q(next), then
    // a backfill of the SEED after them; latest at Q.
    const packaged = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const newer = advanceBuild({ cwd: next.dir, sourceSha: next.sha }).buildSha;
    const backfill = rivalChainCommit(
      fx,
      "seed-backfill",
      fx.seedSha,
      newer,
      "packaged-bundle-bytes-0\n",
    );
    git(backfill.from, "push", "--quiet", "origin", `${backfill.sha}:refs/heads/build`);
    // The rerun's checkout is a full clone at the merge commit; fetching the
    // tag must not cut the seed out of main's history, or the backfill would
    // read as off main.
    const rerun = checkoutOf(fx, "rerun-backfilled", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(result).toEqual({ created: false, packagedSha: packaged.packagedSha, latestSha: newer });
    expect(pushes).toEqual([]);
    expect(latestTag(fx)).toBe(newer);
    // The same checkout then moves the major and confirms: no fetch along the
    // way may have cut the chain's parent links (a shallow marker on a chain
    // commit would read the release as off build).
    expect(retagMajor({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha })).toEqual({
      major: "v2",
      packagedSha: packaged.packagedSha,
    });
    expect(verifyPublishedRefs({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha })).toEqual({
      major: "v2",
      packagedSha: packaged.packagedSha,
    });
  });

  test("a release whose source is older than what latest names appends without moving latest", () => {
    const fx = seedFixture();
    // post-green skipped the merge commit; the next green commit was published.
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const newer = advanceBuild({ cwd: next.dir, sourceSha: next.sha }).buildSha;
    const release = checkoutOf(fx, "release", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: release, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    const tip = buildTip(fx);
    expect(result).toEqual({ created: true, packagedSha: tip, latestSha: newer });
    expect(pushes).toEqual([appendOf(tip), TAG_PUSH]);
    expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(newer);
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(tip);
    expect(latestTag(fx)).toBe(newer);
  });

  test("an append overtaken by a rival packaging the same source tags the rival's commit", () => {
    const fx = seedFixture();
    const rival = rivalChainCommit(
      fx,
      "rival-same",
      fx.mergeSha,
      null,
      "packaged-bundle-bytes-1\n",
    );
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(
      fx,
      [{ competitor: { from: rival.from, sha: rival.sha, ref: "refs/heads/build" } }],
      () => {
        result = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
      },
    );
    expect(result).toEqual({ created: true, packagedSha: rival.sha, latestSha: rival.sha });
    const rejected = appendedSha(pushes[0] ?? []);
    expect(pushes).toEqual([appendOf(rejected), TAG_PUSH, latestOf("", rival.sha)]);
    expect(parentOf(fx.work, rejected)).toBe("");
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(rival.sha);
    expect(buildTip(fx)).toBe(rival.sha);
  });

  test("an append overtaken by a rival packaging another source is retried after it", () => {
    const fx = seedFixture();
    const rival = rivalChainCommit(fx, "rival-other", fx.seedSha, null, "competitor-bundle\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(
      fx,
      [{ competitor: { from: rival.from, sha: rival.sha, ref: "refs/heads/build" } }],
      () => {
        result = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
      },
    );
    const tip = buildTip(fx);
    expect(result).toEqual({ created: true, packagedSha: tip, latestSha: tip });
    const rejected = appendedSha(pushes[0] ?? []);
    expect(pushes).toEqual([appendOf(rejected), appendOf(tip), TAG_PUSH, latestOf("", tip)]);
    expect(parentOf(fx.work, rejected)).toBe("");
    expect(git(fx.origin, "rev-parse", `${tip}^`)).toBe(rival.sha);
    expect(sourceTrailer(fx.origin, tip)).toBe(fx.mergeSha);
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(tip);
  });

  test("a rerun whose rebuild produced different bytes stops loudly", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const before = git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}");
    const rerun = checkoutOf(fx, "rerun-drift", fx.mergeSha, "DIFFERENT-bytes\n");
    expect(() => packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /not a build of/,
    );
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(before);
  });

  /** Plant v2.1.0 (and, when asked, v2) on a commit of `files` over `from` under `message`. */
  function plantTag(
    fx: Fixture,
    name: string,
    from: string,
    message: string[],
    files: Record<string, string>,
    tags: string[] = ["v2.1.0"],
    workflows: "stripped" | "kept" = "stripped",
  ): string {
    const planter = clone(fx.root, fx.origin, name);
    git(planter, "checkout", "--quiet", from);
    if (workflows === "stripped") {
      stripWorkflows(planter);
    }
    for (const [file, content] of Object.entries(files)) {
      write(planter, file, content);
      git(planter, "add", "-f", file);
    }
    git(planter, "commit", "--quiet", "--allow-empty", ...message.flatMap((m) => ["-m", m]));
    for (const tag of tags) {
      git(planter, "tag", tag);
    }
    git(planter, "push", "--quiet", "origin", ...tags.map((tag) => `refs/tags/${tag}`));
    return git(planter, "rev-parse", "HEAD");
  }

  const wrongSource: [string, (fx: Fixture) => string[], RegExp][] = [
    [
      "recording another source",
      (fx) => ["build: by hand", `Source: ${fx.seedSha}`],
      /records [0-9a-f]{40} as its source, not this release's merge commit/,
    ],
    [
      "recording no source",
      () => ["build: package v2.1.0"],
      /records no source, not this release's merge commit/,
    ],
  ];
  test.each(wrongSource)("an existing tag %s stops loudly", (_name, message, error) => {
    const fx = seedFixture();
    const planted = plantTag(fx, "planter", fx.seedSha, message(fx), {
      "lib/index.js": "planted\n",
    });
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      error,
    );
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(planted);
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });

  test("an existing tag that changes more than the bundle stops loudly", () => {
    const fx = seedFixture();
    plantTag(fx, "planter-extra", fx.mergeSha, ["build: by hand", `Source: ${fx.mergeSha}`], {
      "lib/index.js": "packaged-bundle-bytes-1\n",
      "src/marker.ts": "export const marker = 666;\n",
    });
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /is not .* plus lib\/index\.js and the removal of \.github\/workflows\/ alone: .*src\/marker\.ts/,
    );
  });

  test("an existing tag that kept its workflows stops loudly, naming them", () => {
    const fx = seedFixture();
    plantTag(
      fx,
      "planter-workflows",
      fx.mergeSha,
      ["build: by hand", `Source: ${fx.mergeSha}`],
      { "lib/index.js": "packaged-bundle-bytes-1\n" },
      ["v2.1.0"],
      "kept",
    );
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /is not .* plus lib\/index\.js and the removal of \.github\/workflows\/ alone: .*: \.github\/workflows\/ci\.yml \(kept\)\)/,
    );
  });

  /** `count` plumbing-made chain commits of the seed appended after `from` on build. */
  function appendFillers(fx: Fixture, from: string, count: number): string {
    const filler = clone(fx.root, fx.origin, `filler-${from.slice(0, 8)}`);
    git(filler, "checkout", "--quiet", fx.seedSha);
    stripWorkflows(filler);
    write(filler, "lib/index.js", "packaged-bundle-bytes-0\n");
    git(filler, "add", "-f", "lib/index.js");
    const tree = git(filler, "write-tree");
    let tip = from;
    for (let n = 0; n < count; n++) {
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
    return tip;
  }

  test("a release sixty chain commits behind the tip still verifies, on every path", () => {
    const fx = seedFixture();
    const packaged = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const tip = appendFillers(fx, packaged.packagedSha, 60);
    const rerun = checkoutOf(fx, "rerun-deep", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    // latest stays on the release: the fillers package an older source.
    expect(result).toEqual({
      created: false,
      packagedSha: packaged.packagedSha,
      latestSha: packaged.packagedSha,
    });
    expect(pushes).toEqual([]);
    expect(buildTip(fx)).toBe(tip);
    expect(retagMajor({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha })).toEqual({
      major: "v2",
      packagedSha: packaged.packagedSha,
    });
    expect(
      verifyPublishedRefs({
        cwd: shallowChecker(fx, "verify-deep"),
        tag: "v2.1.0",
        sourceSha: fx.mergeSha,
      }),
    ).toEqual({ major: "v2", packagedSha: packaged.packagedSha });
  });

  test("a tag on a commit that is not on build is refused, even with the right tree and bytes", () => {
    const fx = seedFixture();
    // build holds the seed's package; the planted tag has the merge commit's
    // exact chain tree, its bundle bytes, and a Source trailer, but is
    // parented on the merge commit itself, off the chain.
    advanceBuild({
      cwd: checkoutOf(fx, "seed-run", fx.seedSha, "packaged-bundle-bytes-0\n"),
      sourceSha: fx.seedSha,
    });
    const tip = buildTip(fx);
    const planted = plantTag(
      fx,
      "planter-detached",
      fx.mergeSha,
      ["build: by hand", `Source: ${fx.mergeSha}`],
      {
        "lib/index.js": "packaged-bundle-bytes-1\n",
      },
    );
    const refusal =
      `refs/tags/v2.1.0 (${planted}) is not on refs/heads/build (not an ancestor of its tip ` +
      `${tip}); the release-tags ruleset freezes version tags, so no rerun can replace it - ` +
      "inspect it by hand.";
    let error: unknown;
    const pushes = withPushPlans(fx, [], () => {
      try {
        packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
      } catch (thrown) {
        error = thrown;
      }
    });
    expect(error).toEqual(new Error(refusal));
    expect(pushes).toEqual([]);
    // latest stays on the seed's package: the detached commit never becomes what it names.
    expect(latestTag(fx)).toBe(tip);
    expect(() => retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      refusal,
    );
    expect(remoteRef(fx, "refs/tags/v2")).toBe("");
    git(fx.work, "push", "--quiet", "origin", `${planted}:refs/tags/v2`);
    expect(() =>
      verifyPublishedRefs({
        cwd: shallowChecker(fx, "verify-detached"),
        tag: "v2.1.0",
        sourceSha: fx.mergeSha,
      }),
    ).toThrow(`origin's ${refusal}`);
  });

  test("a tag with no build branch at all is refused", () => {
    const fx = seedFixture();
    const planted = plantTag(
      fx,
      "planter-nobuild",
      fx.mergeSha,
      ["build: by hand", `Source: ${fx.mergeSha}`],
      { "lib/index.js": "packaged-bundle-bytes-1\n" },
    );
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      `refs/tags/v2.1.0 (${planted}) exists but refs/heads/build does not exist on origin; ` +
        "the release-tags ruleset freezes version tags, so no rerun can replace it - inspect it by hand.",
    );
  });

  test("a checkout that is not the merge commit refuses to package", () => {
    const fx = seedFixture();
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.seedSha })).toThrow(
      /not the source commit .* to package/,
    );
  });

  test("a source that never reached main is refused before any push, however well its manifest matches", () => {
    const fx = seedFixture();
    // A release-shaped commit (manifest at 2.1.0, release subject) on a side
    // branch: what a draft whose target is not the merge commit would hand
    // the hook. Everything but "is it on main" checks out.
    const side = clone(fx.root, fx.origin, "off-main-release");
    git(side, "checkout", "--quiet", "-b", "side", fx.seedSha);
    write(side, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.1.0" }, null, 2)}\n`);
    const sideSha = commitAll(side, "chore(main): release 2.1.0 (#43)");
    git(side, "push", "--quiet", "origin", "HEAD:refs/heads/side");
    write(side, "lib/index.js", "packaged-bundle-bytes-1\n");
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
        `the release source ${sideSha} is not on origin's main (its head is ${fx.mergeSha}); refusing to package, tag, or publish a commit main does not hold.`,
      ),
    );
    expect(pushes).toEqual([]);
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
    expect(remoteRef(fx, "refs/tags/v2.1.0")).toBe("");
    expect(remoteRef(fx, "refs/tags/latest")).toBe("");
  });

  test("a well-shaped tag for a version this source did not release mints nothing", () => {
    const fx = seedFixture();
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.2.0", sourceSha: fx.mergeSha })).toThrow(
      /did not release/,
    );
    expect(remoteRef(fx, "refs/tags/v2.2.0")).toBe("");
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });

  test("a missing bundle refuses to package", () => {
    const fx = seedFixture();
    rmSync(join(fx.work, "lib/index.js"));
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /not built/,
    );
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });

  test("a worktree dirty beyond the bundle refuses to package", () => {
    const fx = seedFixture();
    write(fx.work, "src/marker.ts", "export const marker = 999;\n");
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /pending changes beyond lib\/index\.js/,
    );
    expect(remoteRef(fx, "refs/tags/v2.1.0")).toBe("");
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });
});

/** The next release's merge landed on origin/main, prepared from a fresh
 * clone (as CI sees it - the previous release's packaged commit lives on
 * build, never in a working branch). */
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
  test("the major moves to the verified chain commit", () => {
    const fx = seedFixture();
    const { packagedSha } = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const moved = retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(moved).toEqual({ major: "v2", packagedSha });
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(packagedSha);
    expect(buildTip(fx)).toBe(packagedSha);

    // The next release in the line force-moves it again, along the chain.
    const next = prepareNextRelease(fx, "2.1.1", 44, "packaged-bundle-bytes-2\n");
    const packaged = packageRelease({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    retagMajor({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(packaged.packagedSha);
    expect(git(fx.origin, "rev-parse", `${packaged.packagedSha}^`)).toBe(packagedSha);
    expect(buildTip(fx)).toBe(packaged.packagedSha);
  });

  test("the major never moves to a package of the wrong source", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(() => retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.seedSha })).toThrow(
      /not this release's merge commit/,
    );
    expect(remoteRef(fx, "refs/tags/v2")).toBe("");
  });

  test("the major never moves to a commit that is not a pure package", () => {
    const fx = seedFixture();
    // Plant v2.1.0 as a bundle-less child of the merge commit naming it as source.
    const planter = clone(fx.root, fx.origin, "planter-empty");
    git(planter, "checkout", "--quiet", fx.mergeSha);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    git(
      planter,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "build: by hand",
      "-m",
      `Source: ${fx.mergeSha}`,
    );
    git(planter, "tag", "v2.1.0");
    git(planter, "push", "--quiet", "origin", "refs/tags/v2.1.0");
    const mover = clone(fx.root, fx.origin, "mover-empty");
    expect(() => retagMajor({ cwd: mover, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /does not carry a non-empty regular-file lib\/index\.js/,
    );
  });

  test("the major never moves to a package whose bundle is not this source's build", () => {
    const fx = seedFixture();
    // Plant v2.1.0 as a well-shaped packaged commit (source and tree pass)
    // carrying the WRONG bundle bytes; only the byte verification catches it.
    const planter = clone(fx.root, fx.origin, "planter-wrong-bytes");
    git(planter, "checkout", "--quiet", fx.mergeSha);
    stripWorkflows(planter);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    write(planter, "lib/index.js", "planted-wrong-bytes\n");
    git(planter, "add", "-f", "lib/index.js");
    git(planter, "commit", "--quiet", "-m", "build: by hand", "-m", `Source: ${fx.mergeSha}`);
    git(planter, "tag", "v2.1.0");
    git(planter, "push", "--quiet", "origin", "refs/tags/v2.1.0");
    const mover = checkoutOf(fx, "mover-wrong-bytes", fx.mergeSha, "packaged-bundle-bytes-1\n");
    expect(() => retagMajor({ cwd: mover, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /not a build of/,
    );
    expect(remoteRef(fx, "refs/tags/v2")).toBe("");
  });

  test("a rerun of an old release's job never moves the major backward", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const next = prepareNextRelease(fx, "2.1.1", 44, "packaged-bundle-bytes-2\n");
    const packaged = packageRelease({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    retagMajor({ cwd: next.dir, tag: "v2.1.1", sourceSha: next.mergeSha });
    // The stale rerun replays the v2.1.0 job on its old merge commit.
    const stale = checkoutOf(fx, "stale-rerun", fx.mergeSha, "packaged-bundle-bytes-1\n");
    packageRelease({ cwd: stale, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(() => retagMajor({ cwd: stale, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /refusing to move v2 back/,
    );
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(packaged.packagedSha);
  });

  test("a lease overtaken by another mover is retried on the re-observed tag", () => {
    const fx = seedFixture();
    const { packagedSha } = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    let result: ReturnType<typeof retagMajor> | undefined;
    const pushes = withPushPlans(
      fx,
      [{ competitor: { from: fx.work, sha: fx.seedSha, ref: "refs/tags/v2" } }],
      () => {
        result = retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
      },
    );
    expect(result).toEqual({ major: "v2", packagedSha });
    expect(pushes).toEqual([majorOf(""), majorOf(fx.seedSha)]);
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(packagedSha);
  });

  test("a lease overtaken on every attempt gives up naming the concurrent mover", () => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const movers = [fx.seedSha, fx.mergeSha, fx.seedSha];
    const pushes = withPushPlans(
      fx,
      movers.map((sha) => ({ competitor: { from: fx.work, sha, ref: "refs/tags/v2" } })),
      () => {
        expect(() => retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
          "could not move v2 after 3 compare-and-swap attempts; something is moving it concurrently - inspect the tag by hand.",
        );
      },
    );
    expect(pushes).toEqual([majorOf(""), majorOf(fx.seedSha), majorOf(fx.mergeSha)]);
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(fx.seedSha);
  });

  test.each(PERMANENT)(
    "%s fails the first lease push for good, with git's own words",
    (_name, stderr) => {
      const fx = seedFixture();
      packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
      let error: unknown;
      const pushes = withPushPlans(fx, [{ fail: { stderr, status: 128 } }], () => {
        try {
          retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
        } catch (thrown) {
          error = thrown;
        }
      });
      expect(pushes).toEqual([majorOf("")]);
      expect(error).toEqual(
        new Error(
          `git push --force-with-lease=refs/tags/v2: origin refs/tags/v2 failed: ${stderr.trim()}`,
        ),
      );
      expect(remoteRef(fx, "refs/tags/v2")).toBe("");
    },
  );
});

describe("verifyPublishedRefs", () => {
  test("the version tag and the major point at the same packaged, bundle-carrying chain commit", () => {
    const fx = seedFixture();
    // build already holds the seed's package, so the release's chain commit
    // is appended behind it rather than minted as the root; the merge
    // commit's tree reaches the shallow checker only through the
    // confirmation's own fetch.
    advanceBuild({
      cwd: checkoutOf(fx, "seed-run", fx.seedSha, "packaged-bundle-bytes-0\n"),
      sourceSha: fx.seedSha,
    });
    const { packagedSha } = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const checker = shallowChecker(fx, "verify-fresh");
    const verified = verifyPublishedRefs({ cwd: checker, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(verified).toEqual({ major: "v2", packagedSha });
    expect(packagedSha).toBe(buildTip(fx));
    // Later green pushes move the tip past the tag; the confirmation from a
    // fresh shallow checkout still finds the tag's commit on the chain.
    for (const name of ["third-green", "fourth-green"]) {
      const next = pushGreenCommit(fx, name, `packaged-bundle-${name}\n`);
      advanceBuild({ cwd: next.dir, sourceSha: next.sha });
    }
    expect(buildTip(fx)).not.toBe(packagedSha);
    expect(
      verifyPublishedRefs({
        cwd: shallowChecker(fx, "verify-behind"),
        tag: "v2.1.0",
        sourceSha: fx.mergeSha,
      }),
    ).toEqual({ major: "v2", packagedSha });
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

  test("a version tag that changes more than the bundle fails the confirmation", () => {
    const fx = seedFixture();
    // The merge commit's chain tree (minus workflows, plus the bundle) plus a tampered action.yml,
    // parented on the seed so nothing but the confirmation's own fetch can
    // bring the merge commit's tree to a shallow checkout.
    const planter = clone(fx.root, fx.origin, "verify-planter-extra");
    git(planter, "checkout", "--quiet", fx.mergeSha);
    stripWorkflows(planter);
    write(planter, "lib/index.js", "packaged-bundle-bytes-1\n");
    write(planter, "action.yml", "name: tampered\n");
    git(planter, "add", "-f", "lib/index.js", "action.yml");
    const planted = git(
      planter,
      "commit-tree",
      git(planter, "write-tree"),
      "-p",
      fx.seedSha,
      "-m",
      "build: by hand",
      "-m",
      `Source: ${fx.mergeSha}`,
    );
    git(
      planter,
      "push",
      "--quiet",
      "origin",
      `${planted}:refs/tags/v2.1.0`,
      `${planted}:refs/tags/v2`,
    );
    const checker = shallowChecker(fx, "verify-tampered");
    expect(() =>
      verifyPublishedRefs({ cwd: checker, tag: "v2.1.0", sourceSha: fx.mergeSha }),
    ).toThrow(
      /is not .* plus lib\/index\.js and the removal of \.github\/workflows\/ alone: .*action\.yml/,
    );
  });

  test("a version tag recording another source fails the confirmation", () => {
    const fx = seedFixture();
    const planter = clone(fx.root, fx.origin, "verify-planter");
    git(planter, "checkout", "--quiet", fx.seedSha);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    write(planter, "lib/index.js", "planted\n");
    git(planter, "add", "-f", "lib/index.js");
    git(planter, "commit", "--quiet", "-m", "build: by hand", "-m", `Source: ${fx.seedSha}`);
    git(planter, "tag", "v2.1.0");
    git(planter, "tag", "v2");
    git(planter, "push", "--quiet", "origin", "refs/tags/v2.1.0", "refs/tags/v2");
    const checker = clone(fx.root, fx.origin, "verify-wrong-source");
    expect(() =>
      verifyPublishedRefs({ cwd: checker, tag: "v2.1.0", sourceSha: fx.mergeSha }),
    ).toThrow(
      `origin's refs/tags/v2.1.0 points at ${git(planter, "rev-parse", "HEAD")}, which records ${fx.seedSha} as its source, not this release's merge commit ${fx.mergeSha}.`,
    );
  });
});

/** Simulate release-please's PR branch: manifest + changelog bumped for the
 * next version, built on the given main head; pushed (force) unless asked
 * to keep the commit local for a competitor plan. */
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
    expect(result).toEqual({
      changed: true,
      reason: `release-please--branches--main: anchored at ${fx.mergeSha}`,
    });
    expect(pushes).toEqual([ANCHOR_PUSH, ANCHOR_PUSH]);
    // The anchor sits on the REFRESHED branch: its content is 2.3.0's.
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
    const body = git(fx.origin, "log", "-1", "--format=%B", tip);
    expect(body).toContain(`build: main at ${git(fx.origin, "rev-parse", "--short", fx.mergeSha)}`);
    expect(body).toContain("Workflow-run: https://example.invalid/actions/runs/7");
    expect(sourceTrailer(fx.origin, tip)).toBe(fx.mergeSha);
    // The checkout itself is untouched: HEAD still the source, index clean.
    expect(git(fx.work, "rev-parse", "HEAD")).toBe(fx.mergeSha);
    expect(git(fx.work, "status", "--porcelain")).toBe("");

    // Idempotent rerun from a fresh checkout that rebuilt the bundle.
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
    // The stale rerun's checkout is cloned BEFORE the newer commit exists:
    // it must learn that commit from origin to see build as already past.
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

    // The stale rerun of the older commit's run finds its commit behind the
    // tip and leaves both refs where the newer run put them.
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
    // main changes a workflow and adds another; the chain commit that follows
    // carries neither (GitHub's refusal of workflow pushes to a token without
    // the workflows grant is judged per push, so this is the shape the fixture
    // can pin), and its diff against its own source is the removal plus the bundle.
    const dir = clone(fx.root, fx.origin, "workflow-change");
    write(dir, ".github/workflows/ci.yml", "name: ci\non: [push, pull_request]\njobs: {}\n");
    write(dir, ".github/workflows/nightly.yml", "name: nightly\non: schedule\njobs: {}\n");
    const sha = commitAll(dir, "ci: change the workflows");
    git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    write(dir, "lib/index.js", "packaged-bundle-bytes-2\n");
    const second = advanceBuild({ cwd: dir, sourceSha: sha });
    expect(second.changed).toBe(true);
    expect(parentOf(fx.origin, second.buildSha)).toBe(first);
    expect(
      treePaths(fx.origin, second.buildSha).filter((path) => path.startsWith(".github/workflows/")),
    ).toEqual([]);
    expect(git(fx.origin, "diff", "--name-only", sha, second.buildSha)).toBe(
      ".github/workflows/ci.yml\n.github/workflows/nightly.yml\nlib/index.js",
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

  /** A hand-planted refs/tags/latest naming `source` in a Source trailer:
   * `source`'s tree minus workflows plus `files` over the planted bundle,
   * parented on `parent`, force-pushed as the tag. */
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
    write(planter, "lib/index.js", "planted\n");
    git(planter, "add", "-f", "lib/index.js");
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
      // A newer main commit build has not packaged yet: its Source trailer
      // alone would read as "newer, leave it".
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
    // Fifty-one release backfills of an older source land after it; rolling
    // latest back to the older tip would be wrong however long the chain.
    const filler = clone(fx.root, fx.origin, "latest-filler");
    git(filler, "checkout", "--quiet", fx.seedSha);
    stripWorkflows(filler);
    write(filler, "lib/index.js", "packaged-bundle-bytes-0\n");
    git(filler, "add", "-f", "lib/index.js");
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
      reason: `refs/heads/build already packages ${fx.seedSha} at ${tip}; refs/tags/latest stays at ${kept} (built from ${fx.mergeSha}), newer than ${tip} (built from ${fx.seedSha}); the next green push appends past it`,
    });
    expect(pushes).toEqual([]);
    expect(latestTag(fx)).toBe(kept);
  });

  test("an annotated latest on a valid newer chain commit is left alone by a stale rerun", () => {
    const fx = seedFixture();
    advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
    const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
    const newer = advanceBuild({ cwd: next.dir, sourceSha: next.sha }).buildSha;
    // The release hook backfills the seed after it; latest is then re-made by
    // hand as an ANNOTATED tag at the newer commit (its id is a tag object).
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
      reason: `refs/heads/build already packages ${fx.seedSha} at ${backfill.sha}; refs/tags/latest stays at ${newer} (built from ${next.sha}), newer than ${backfill.sha} (built from ${fx.seedSha}); the next green push appends past it`,
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

  /** A hand-pushed refs/heads/build: a child of `from` under `message`
   * carrying `files` (by default just a bundle that is not CI's build; a
   * `{ linkTo }` value plants a symlink), force-pushed over whatever build held. */
  function plantBuild(
    fx: Fixture,
    name: string,
    from: string,
    message: string[],
    files: Record<string, string | { linkTo: string }> = { "lib/index.js": "planted\n" },
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
    const paragraphs = message.flatMap((paragraph) => ["-m", paragraph]);
    git(planter, "commit", "--quiet", "--allow-empty", ...paragraphs);
    git(planter, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/build");
    return git(planter, "rev-parse", "HEAD");
  }

  /** A side branch off `from` that never reached main, pushed to origin; a
   * build tip built from it names a source off main's history. */
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

  /** The tree `source` minus workflows plus the planted bundle would have:
   * what a tip that names `source` is held against. */
  function rebuiltTree(fx: Fixture, name: string, source: string): string {
    const rebuild = clone(fx.root, fx.origin, name);
    git(rebuild, "checkout", "--quiet", source);
    stripWorkflows(rebuild);
    write(rebuild, "lib/index.js", "planted\n");
    git(rebuild, "add", "-f", "lib/index.js");
    return git(rebuild, "write-tree");
  }

  /** The exact refusal for a commit whose tree is not its Source plus the
   * bundle: `where` is how the pipeline met it (the tip it is at, or a
   * commit found holding it). */
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
        `${source} plus lib/index.js and the removal of .github/workflows/ alone: its tree is ` +
        `${actual}, the rebuilt one is ${expected} (paths beyond those changed relative to ` +
        `${source}: ${changed}); ${byHand}`,
    );
  }

  /** A tip crafted with plumbing: `from`'s tree minus workflows plus the
   * planted bundle plus an EMPTY subtree at `empty/`, which a path diff
   * cannot list. */
  function plantEmptySubtreeBuild(fx: Fixture, from: string): string {
    const planter = clone(fx.root, fx.origin, "build-empty-subtree");
    git(planter, "checkout", "--quiet", from);
    stripWorkflows(planter);
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
        // Descends from main's head, so ancestry alone would read it as a
        // newer run's work; only its absence from main tells it apart.
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
      "naming this source but changing more than the bundle",
      (fx) => {
        const planted = plantBuild(
          fx,
          "build-extra",
          fx.mergeSha,
          ["build: by hand", `Source: ${fx.mergeSha}`],
          { "lib/index.js": "planted\n", "src/marker.ts": "export const marker = 666;\n" },
        );
        return { planted, error: notAPackage(fx, "holds", planted, fx.mergeSha, "src/marker.ts") };
      },
    ],
    [
      "naming this source with a bundle that is not this checkout's build",
      (fx) => {
        // The tree CI's build of this source packages, taken from a genuine
        // advance; the planted tip then replaces it with another bundle.
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
              `${fx.mergeSha} packages, so the two differ in their lib/index.js entry (bytes or ` +
              "file mode): either the commit was not built from this source or the build is not " +
              "reproducible, and the Source trailer cannot tell those apart. Diff the two trees " +
              "by hand; a hand-pushed commit is left for the next green push to bury (the ruleset " +
              "on build forbids moving it back), a build that differs between runs is fixed " +
              "before build can be trusted.",
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
        // A symlink at the bundle's path has a size (its target text), so a
        // size probe alone would bless a tip consumers cannot run.
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
        // Invisible to a path diff (no path lives in an empty tree), so only
        // tree identity catches it.
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
      "naming an older main commit and carrying a file beyond the bundle",
      (fx) => {
        // The append path: an older source is a valid parent only when its
        // tip is a pure package, never with a foreign file riding along.
        const planted = plantBuild(
          fx,
          "build-older-extra",
          fx.seedSha,
          ["build: by hand", `Source: ${fx.seedSha}`],
          { "lib/index.js": "planted\n", "src/marker.ts": "export const marker = 666;\n" },
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

  test("an empty bundle never reaches build", () => {
    const fx = seedFixture();
    write(fx.work, "lib/index.js", "");
    expect(() => advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha })).toThrow(
      /does not carry a non-empty regular-file lib\/index\.js/,
    );
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
    expect(remoteRef(fx, "refs/tags/latest")).toBe("");
  });

  test("a shallow checkout is refused before any verdict", () => {
    const fx = seedFixture();
    const dir = join(fx.root, "build-shallow");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${fx.origin}`, dir]);
    write(dir, "lib/index.js", "packaged-bundle-bytes-1\n");
    expect(() => advanceBuild({ cwd: dir, sourceSha: fx.mergeSha })).toThrow(
      /needs the full history.*shallow/,
    );
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });

  /** `count` packaged commits of the seed, chained from a root (the shape
   * the pipeline mints while build does not exist), in a clone that has not
   * pushed them: what other runs would append to build, as the plans that
   * land one ahead of each of this run's pushes. */
  function competitors(
    fx: Fixture,
    count: number,
  ): { from: string; plans: PushPlan[]; shas: string[]; first: string; last: string } {
    const from = clone(fx.root, fx.origin, "build-competitor");
    git(from, "checkout", "--quiet", fx.seedSha);
    stripWorkflows(from);
    write(from, "lib/index.js", "competitor-bundle\n");
    git(from, "add", "-f", "lib/index.js");
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

  /** The retried outcome after one overtaken append: build landed as the
   * child of the rival's tip, latest followed, and the pushes carried a
   * child of `before` (the tip this run first observed, rejected; "" for a
   * root, minted while build did not exist), then the child of the rival's
   * tip, then the latest lease. */
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

  // The rival lands DURING the pipeline's push: origin's update hook moves
  // build once receive-pack has advertised it, so the update itself fails
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
    // The scripted loss lands nothing, so the retry finds no build and
    // pushes the source's own root package again, this time for real.
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
    // Each attempt re-read the tip and built on it before being overtaken
    // again: a root first, then a child of each rival tip but the last.
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
      // One push, of the source's own root package, then the failure as git
      // worded it: no retry, no "moving it concurrently", no latest.
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
    test("a release backfill landing between this run's append and its latest move does not hide this run's newer commit", () => {
      const fx = seedFixture();
      // latest names the seed's package; the 2.1.0 merge was skipped by post-green.
      const older = advanceBuild({
        cwd: checkoutOf(fx, "seed-run", fx.seedSha, "packaged-bundle-bytes-0\n"),
        sourceSha: fx.seedSha,
      }).buildSha;
      const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
      // The instant this run's append lands, the release hook's backfill of
      // the merge commit lands on top of it: origin's post-receive hook
      // appends it, so the tip this run reads next is the backfill.
      const rival = clone(fx.root, fx.origin, "backfill");
      git(rival, "checkout", "--quiet", fx.mergeSha);
      stripWorkflows(rival);
      write(rival, "lib/index.js", "packaged-bundle-bytes-1\n");
      git(rival, "add", "-f", "lib/index.js");
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
      // latest names this run's commit, the newest source, not the backfilled tip.
      expect(result).toEqual({
        changed: true,
        buildSha: own,
        latestSha: own,
        reason: `refs/heads/build: advanced to ${own}; refs/tags/latest: moved to ${own}`,
      });
      expect(pushes).toEqual([appendOf(own), latestOf(older, own)]);
      expect(latestTag(fx)).toBe(own);
      // A rerun of the merge commit's post-green leaves it there.
      const rerun = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
      expect(rerun).toEqual({
        changed: false,
        buildSha: tip,
        latestSha: own,
        reason: `refs/heads/build already packages ${fx.mergeSha} at ${tip}; refs/tags/latest stays at ${own} (built from ${next.sha}), newer than ${tip} (built from ${fx.mergeSha}); the next green push appends past it`,
      });
      expect(latestTag(fx)).toBe(own);
    });

    test("a stale rerun after the release hook appended an older source leaves latest on the newer source until a green push passes it", () => {
      const fx = seedFixture();
      // Post-green skipped the 2.1.0 merge; the next green commit reached build first.
      const next = pushGreenCommit(fx, "second-green", "packaged-bundle-bytes-2\n");
      const newer = advanceBuild({ cwd: next.dir, sourceSha: next.sha }).buildSha;
      // The release hook then appends the merge commit's package after it.
      const release = checkoutOf(fx, "release-backfill", fx.mergeSha, "packaged-bundle-bytes-1\n");
      const older = packageRelease({
        cwd: release,
        tag: "v2.1.0",
        sourceSha: fx.mergeSha,
      }).packagedSha;
      expect(buildTip(fx)).toBe(older);
      expect(latestTag(fx)).toBe(newer);
      // A rerun of the merge commit's post-green must not lease latest back.
      let result: ReturnType<typeof advanceBuild> | undefined;
      const pushes = withPushPlans(fx, [], () => {
        result = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha });
      });
      expect(result).toEqual({
        changed: false,
        buildSha: older,
        latestSha: newer,
        reason: `refs/heads/build already packages ${fx.mergeSha} at ${older}; refs/tags/latest stays at ${newer} (built from ${next.sha}), newer than ${older} (built from ${fx.mergeSha}); the next green push appends past it`,
      });
      expect(pushes).toEqual([]);
      expect(latestTag(fx)).toBe(newer);
      // The next green push appends past the backfill and latest follows again.
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
      // Plan 2 (the lease push) is beaten by a hand move of latest.
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
    // creating a tag on main; the hook mints the only tag, on the build
    // branch's chain commit. include-component-in-tag: false keeps tags
    // strictly vX.Y.Z, the one shape releaseMajor() accepts.
    // skip-github-release would stop releases entirely (release_created
    // never fires, the hook never runs).
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
    expect(remoteRef(fx, "refs/tags/v2.1-rc.0")).toBe("");
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });
});
