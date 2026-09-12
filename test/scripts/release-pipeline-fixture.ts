/**
 * The fixture harness behind the release pipeline tests: a bare origin plus clones playing the CI checkouts, a git
 * shim first on PATH that refuses a push outside the fixture area and plays scripted remotes (rivals, refusals,
 * a landing between a read and the write it informs), and the helpers the test files share.
 */

import { afterAll, beforeAll, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PREPARATION_SCRIPTS } from "../../.github/scripts/release-pipeline.js";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Resolved to its physical path: the shim compares against `pwd -P`. */
const FIXTURE_AREA = realpathSync(tmpdir());
const FIXTURE_PREFIX = "release-pipeline-";
const PLANS_ENV = "RELEASE_PIPELINE_PUSH_PLANS";

export const roots: string[] = [];

/** The shim's refusal, as it prints it. */
export function guardRefusal(cwd: string): string {
  return `release-pipeline fixture guard: refusing git push from ${cwd}, which is not inside ${FIXTURE_AREA}/${FIXTURE_PREFIX}*/`;
}

/** The git shim first on PATH refuses a push outside the fixture area, so no test can reach a real remote. */
let shimDir = "";
/** PATH as it was before the shim went first; undefined until it did. */
let realPath: string | undefined;
/** The real git, for a scripted rival that must not be logged as one of the pipeline's pushes. */
export let realGit = "";

/** The per-file hooks: the shim goes first on PATH before the file's tests and comes off after them, and the
 * fixture roots the file created are removed; a test file calls this once at module scope. */
export function installReleasePipelineFixture(): void {
  afterAll(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });
  beforeAll(() => {
    realGit = Bun.which("git") ?? "";
    if (realGit === "") {
      throw new Error("no git on PATH");
    }
    shimDir = mkdtempSync(join(tmpdir(), "release-pipeline-shim-"));
    const script = [
      "#!/bin/sh",
      `plans="$${PLANS_ENV}"`,
      // The ls-remote hook runs once, after the read it names, with its output kept off the pipe the pipeline parses.
      'if [ "$1" = "ls-remote" ] && [ -n "$plans" ] && [ -f "$plans/after-ls-remote.sh" ]; then',
      `  "${realGit}" "$@"`,
      "  status=$?",
      '  naming=$(cat "$plans/after-ls-remote.naming")',
      '  case " $* " in',
      '    *" $naming "*) mv "$plans/after-ls-remote.sh" "$plans/after-ls-remote.fired"; sh "$plans/after-ls-remote.fired" >&2 ;;',
      "  esac",
      '  exit "$status"',
      "fi",
      `if [ "$1" != "push" ]; then exec "${realGit}" "$@"; fi`,
      'here="$(pwd -P)"',
      'case "$here/" in',
      `  "${FIXTURE_AREA}"/${FIXTURE_PREFIX}*/*) ;;`,
      `  *) echo "release-pipeline fixture guard: refusing git push from $here, which is not inside ${FIXTURE_AREA}/${FIXTURE_PREFIX}*/" >&2; exit 1 ;;`,
      "esac",
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
}

/** Hermetic clone: the developer's global gitconfig (identity, signing, hooks) must not leak into the fixtures. */
export function clone(root: string, originDir: string, name: string): string {
  const dir = join(root, name);
  execFileSync("git", ["clone", "--quiet", originDir, dir]);
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgSign", "false");
  git(dir, "config", "core.hooksPath", join(root, "no-hooks"));
  return dir;
}

export function write(cwd: string, file: string, content: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), content);
}

export function commitAll(cwd: string, subject: string): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", subject);
  return git(cwd, "rev-parse", "HEAD");
}

/** The files a build of `bundle` leaves in a checkout: the action bundle and
 * the library build (its module and its declarations), all gitignored on main. */
export function builtFiles(bundle: string): Record<string, string> {
  return {
    "lib/index.js": bundle,
    "lib/pkg/index.js": `library-${bundle}`,
    "lib/pkg/index.d.ts": `types-${bundle}`,
  };
}

export function writeBuild(cwd: string, bundle: string): void {
  for (const [file, content] of Object.entries(builtFiles(bundle))) {
    write(cwd, file, content);
  }
}

/** Stage the build outputs into a clone's index as the pipeline does (-f: they are gitignored). */
export function stageBuild(cwd: string): void {
  git(cwd, "add", "-f", "--", "lib/index.js", "lib/pkg");
}

/** The fixture's package.json: one of each script pacote takes as a preparation trigger, beside one that is not. */
export function manifestJson(
  version: string,
  scripts: Record<string, string> = FIXTURE_SCRIPTS,
): string {
  return `${JSON.stringify({ name: "@scope/pkg", version, scripts }, null, 2)}\n`;
}
const FIXTURE_SCRIPTS = {
  ...Object.fromEntries(PREPARATION_SCRIPTS.map((name) => [name, `echo ${name}`])),
  test: "bun test",
};
/** FIXTURE_SCRIPTS after the pipeline's strip: the preparation scripts gone, the rest kept. */
export const STRIPPED_SCRIPTS = { test: "bun test" };

/** What a chain commit's package.json looks like: the pipeline strips the preparation scripts when it mints one. */
export function stripPrepare(cwd: string): void {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const name of PREPARATION_SCRIPTS) {
    delete pkg.scripts?.[name];
  }
  write(cwd, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  git(cwd, "add", "package.json");
}

/** Whether a planter should strip the manifest as the pipeline does: the files include the library build (only
 * commits minted after the strip carry it) and no explicit package.json says what the manifest is instead. */
export function shouldStripManifest(files: Record<string, unknown>): boolean {
  return (
    Object.keys(files).some((file) => file.startsWith("lib/pkg/")) && !("package.json" in files)
  );
}

/** What every packaged tree lacks, so a planted chain commit deviates from the pipeline's only where the test means it to. */
export function stripWorkflows(cwd: string): void {
  git(cwd, "rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ".github/workflows");
}

export function treePaths(cwd: string, sha: string): string[] {
  return git(cwd, "ls-tree", "-r", "--name-only", sha).split("\n");
}

/** The paths a chain commit's diff against its source lists: the workflow removal and the build outputs. */
export const PACKAGED_DIFF =
  ".github/workflows/ci.yml\nlib/index.js\nlib/pkg/index.d.ts\nlib/pkg/index.js\npackage.json";

export const CHANGELOG_21 = `# Changelog

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

export interface Fixture {
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
export function seedFixture(): Fixture {
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

export function checkoutOf(fx: Fixture, name: string, sha: string, bundle: string): string {
  const dir = clone(fx.root, fx.origin, name);
  git(dir, "checkout", "--quiet", sha);
  writeBuild(dir, bundle);
  return dir;
}

/** A later green push to main as CI sees it: a fresh clone at the new head with the bundle "built" from it. */
export function pushGreenCommit(
  fx: Fixture,
  name: string,
  bundle: string,
): { dir: string; sha: string } {
  const dir = clone(fx.root, fx.origin, name);
  write(dir, "src/marker.ts", `export const marker = "${name}";\n`);
  const sha = commitAll(dir, `feat: ${name}`);
  git(dir, "push", "--quiet", "origin", "HEAD:refs/heads/main");
  writeBuild(dir, bundle);
  return { dir, sha };
}

/** The Source trailer as git parses it, proving the value sits in a real trailer block rather than somewhere in the body. */
export function sourceTrailer(cwd: string, sha: string): string {
  return git(cwd, "log", "-1", "--format=%(trailers:key=Source,valueonly)", sha);
}

/**
 * The verify job's checkout: depth 1 at main's head after main moved past the merge commit, so only the confirmation's own fetch can supply the merge
 * commit's tree.
 */
export function shallowChecker(fx: Fixture, name: string): string {
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

export const buildTip = (fx: Fixture): string => git(fx.origin, "rev-parse", "refs/heads/build");
/** Author and committer of a commit, as the pipeline must stamp its own. */
export const identityOf = (cwd: string, sha: string): string =>
  git(cwd, "log", "-1", "--format=%an <%ae> / %cn <%ce>", sha);
const BOT = "settings-as-code-release <settings-as-code-release@users.noreply.github.com>";
export const BOT_IDENTITY = `${BOT} / ${BOT}`;
/** The identity a clone's own config carries after the pipeline ran in it: clone() set it, and it must stay
 * (a repo config the pipeline wrote would outlive the run and stamp every later commit from that checkout). */
export const localIdentity = (cwd: string): string =>
  `${git(cwd, "config", "--local", "--get", "user.name")} <${git(cwd, "config", "--local", "--get", "user.email")}>`;
export const FIXTURE_IDENTITY = "fixture <fixture@example.invalid>";
/** A commit's first parent as its object records it, whatever ref or shallow state the reading clone is in. */
export const parentOf = (cwd: string, sha: string): string =>
  git(cwd, "cat-file", "-p", sha).match(/^parent ([0-9a-f]{40})$/m)?.[1] ?? "";
export const latestTag = (fx: Fixture): string =>
  git(fx.origin, "rev-parse", "refs/tags/latest^{}");
export const remoteRef = (fx: Fixture, ref: string): string =>
  git(fx.work, "ls-remote", "origin", ref);

/** A chain-shaped commit minted by another writer, not pushed; the clone holding it is returned for a competitor plan to push from. */
export function rivalChainCommit(
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
export type PushPlan =
  /** Force-push `sha` to `ref` first from the clone `from`; real git then judges the pipeline's push. */
  | { competitor: { from: string; sha: string; ref: string } }
  /** Run this shell first (a rival whose commit depends on origin's state at that moment). */
  | { script: string }
  /** Replay a remote a file:// origin cannot play: this stderr, this exit status. */
  | { fail: { stderr: string; status: number } };

/** What the shim does to the pipeline's remote reads and writes. */
export interface RemotePlans {
  /** The n-th push's plan, or null to let it through. */
  pushes?: (PushPlan | null)[];
  /** Run this shell ONCE, right after the first ls-remote whose arguments include `naming`: a rival landing between
   * that read and the write it informs. */
  afterLsRemote?: { naming: string; script: string };
}

export function withPushPlans(
  fx: Fixture,
  plans: (PushPlan | null)[],
  body: () => void,
): string[][] {
  return withRemotePlans(fx, { pushes: plans }, body);
}

export function withRemotePlans(fx: Fixture, remote: RemotePlans, body: () => void): string[][] {
  const plansDir = mkdtempSync(join(fx.root, "push-plans-"));
  if (remote.afterLsRemote !== undefined) {
    writeFileSync(join(plansDir, "after-ls-remote.naming"), `${remote.afterLsRemote.naming}\n`);
    writeFileSync(join(plansDir, "after-ls-remote.sh"), remote.afterLsRemote.script);
  }
  for (const [index, plan] of (remote.pushes ?? []).entries()) {
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

export const appendOf = (sha: string): string[] => ["push", "origin", `${sha}:refs/heads/build`];
export const latestOf = (observed: string, tip: string): string[] => [
  "push",
  `--force-with-lease=refs/tags/latest:${observed}`,
  "origin",
  `${tip}:refs/tags/latest`,
];
export const majorOf = (observed: string): string[] => [
  "push",
  `--force-with-lease=refs/tags/v2:${observed}`,
  "origin",
  "refs/tags/v2",
];
export const TAG_PUSH = ["push", "origin", "refs/tags/v2.1.0"];
export const ANCHOR_PUSH = ["push", "origin", "HEAD:refs/heads/release-please--branches--main"];
/** The commit a logged append carried (its objects exist in the pushing clone). */
export const appendedSha = (push: string[]): string =>
  push.join(" ").replace(/^push origin (\w+):refs\/heads\/build$/, "$1");

/** Remotes a file:// origin cannot play, as git words them; none is a retry's to win. */
export const PERMANENT: [string, string][] = [
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
