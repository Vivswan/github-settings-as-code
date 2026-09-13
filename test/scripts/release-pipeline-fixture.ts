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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
/** The real git, which the shim execs. */
let realGit = "";

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

/** A fixture repository does nothing between the commands a test runs in it. Since git 2.54 every push and fetch
 * spawns a detached `git maintenance run --auto` whose geometric repack packs and deletes the loose objects as soon
 * as two of them share the objects/17 shard; a plain-path clone copying the origin's loose objects at that moment
 * dies with "failed to copy file ... No such file or directory". Origins take pushes and clones fetch, so all get it. */
function disableBackgroundMaintenance(dir: string): void {
  git(dir, "config", "maintenance.auto", "false");
}

/** Hermetic clone: the developer's global gitconfig (identity, signing, hooks) must not leak into the fixtures. */
export function clone(
  root: string,
  originDir: string,
  name: string,
  options: { tags: boolean } = { tags: true },
): string {
  const dir = join(root, name);
  execFileSync("git", ["clone", "--quiet", ...(options.tags ? [] : ["--no-tags"]), originDir, dir]);
  disableBackgroundMaintenance(dir);
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

/** The fixture's package.json: one of each script pacote takes as a preparation trigger, beside one that is not. */
export function manifestJson(
  version: string,
  scripts: Record<string, string> = FIXTURE_SCRIPTS,
): string {
  return `${JSON.stringify({ name: "@scope/pkg", version, scripts }, null, 2)}\n`;
}
/** The six scripts pacote reads before it prepares a git dependency, spelled here so a name dropped from the
 * pipeline's list would stay in a packaged manifest and fail the manifest assertion. */
const PREPARATION_SCRIPTS = ["prepare", "prepack", "build", "preinstall", "install", "postinstall"];
const FIXTURE_SCRIPTS = {
  ...Object.fromEntries(PREPARATION_SCRIPTS.map((name) => [name, `echo ${name}`])),
  test: "bun test",
};
/** FIXTURE_SCRIPTS after the pipeline's strip: the preparation scripts gone, the rest kept. */
const STRIPPED_SCRIPTS = { test: "bun test" };

/** What a packaged commit's package.json looks like: the pipeline strips the preparation scripts when it mints one. */
function stripPrepare(cwd: string): void {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  for (const name of PREPARATION_SCRIPTS) {
    delete pkg.scripts?.[name];
  }
  write(cwd, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  git(cwd, "add", "package.json");
}

function treePaths(cwd: string, sha: string): string[] {
  return git(cwd, "ls-tree", "-r", "--name-only", sha).split("\n");
}

/** The paths a packaged commit's diff against its source lists: the build outputs and the stripped manifest. */
const PACKAGED_DIFF = "lib/index.js\nlib/pkg/index.d.ts\nlib/pkg/index.js\npackage.json";

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

/** The whole packaged-commit contract: `source`'s child, its tree plus the build of `bundle` and the stripped
 * manifest and nothing else, the pipeline's subject and run trailer, the bot identity. */
export function expectPackage(
  fx: Fixture,
  packaged: string,
  source: string,
  bundle: string,
  runUrl: string,
): void {
  expect(parentsOf(fx.origin, packaged)).toEqual([source]);
  expect(git(fx.origin, "diff", "--name-only", source, packaged)).toBe(PACKAGED_DIFF);
  expect(treePaths(fx.origin, packaged)).toEqual([
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
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
  for (const [file, content] of Object.entries(builtFiles(bundle))) {
    expect(git(fx.origin, "show", `${packaged}:${file}`)).toBe(content);
  }
  expect(git(fx.origin, "show", `${packaged}:package.json`)).toBe(
    manifestJson(
      git(fx.origin, "show", `${source}:.release-please-manifest.json`).match(
        /"\."\s*:\s*"([^"]+)"/,
      )?.[1] ?? "",
      STRIPPED_SCRIPTS,
    ).trimEnd(),
  );
  expect(git(fx.origin, "log", "-1", "--format=%B", packaged)).toBe(
    `build: main at ${git(fx.origin, "rev-parse", "--short", source)}\n\nWorkflow-run: ${runUrl}`,
  );
  expect(identityOf(fx.origin, packaged)).toBe(BOT_IDENTITY);
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
  disableBackgroundMaintenance(origin);
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
  // A workflow file rides along in every packaged commit: its parent is the source, so no diff GitHub judges shows a workflow change.
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

/** Where a main commit sits on origin's main: its first-parent count, the position its build tag carries. */
export const positionOf = (fx: Fixture, sha: string): number =>
  Number(git(fx.origin, "rev-list", "--count", "--first-parent", sha));
/** The build tag the pipeline names for a main commit. */
export const buildTagOf = (fx: Fixture, sha: string): string =>
  `refs/tags/build/${positionOf(fx, sha)}.${sha.slice(0, 7)}`;
/** Every build tag origin holds, in ref order. */
export const buildTags = (fx: Fixture): string[] =>
  git(fx.origin, "for-each-ref", "--format=%(refname)", "refs/tags/build/")
    .split("\n")
    .filter(Boolean);
/** The packaged commit a main commit's build tag names on origin. */
export const packagedOf = (fx: Fixture, sha: string): string =>
  git(fx.origin, "rev-parse", `${buildTagOf(fx, sha)}^{}`);
/** Whether origin still holds a commit object: a pruned tag's commit stays until origin collects it, one a
 * release tag or latest names stays for good. */
export function originHolds(fx: Fixture, sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: fx.origin, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A depth-1 clone of origin's main: what a shallow checkout gives the pipeline. */
export function shallowClone(fx: Fixture, name: string): string {
  const dir = join(fx.root, name);
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${fx.origin}`, dir]);
  disableBackgroundMaintenance(dir);
  return dir;
}

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
/** A commit's parents as its object records them, whatever ref or shallow state the reading clone is in. */
export const parentsOf = (cwd: string, sha: string): string[] =>
  [...git(cwd, "cat-file", "-p", sha).matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1] ?? "");
export const latestTag = (fx: Fixture): string =>
  git(fx.origin, "rev-parse", "refs/tags/latest^{}");
export const remoteRef = (fx: Fixture, ref: string): string =>
  git(fx.work, "ls-remote", "origin", ref);

/** A commit planted over `parent` from `source`'s tree: the pipeline's shape (build outputs staged, manifest
 * stripped) plus `files` over it, unpushed. `message` paragraphs default to the pipeline's subject. */
export function plantCommit(
  fx: Fixture,
  name: string,
  source: string,
  parent: string | null,
  files: Record<string, string | { linkTo: string }> = builtFiles("planted\n"),
  message: string[] = ["build: by hand"],
): { from: string; sha: string } {
  const from = clone(fx.root, fx.origin, name);
  return { from, sha: plantCommitIn(from, source, parent, files, message) };
}

/** plantCommit inside an existing clone, for a source that clone alone holds. */
export function plantCommitIn(
  from: string,
  source: string,
  parent: string | null,
  files: Record<string, string | { linkTo: string }>,
  message: string[],
): string {
  git(from, "checkout", "--quiet", source);
  for (const [file, content] of Object.entries(files)) {
    if (typeof content === "string") {
      write(from, file, content);
    } else {
      mkdirSync(dirname(join(from, file)), { recursive: true });
      symlinkSync(content.linkTo, join(from, file));
    }
    git(from, "add", "-f", file);
  }
  if (!("package.json" in files)) {
    stripPrepare(from);
  }
  return git(
    from,
    "commit-tree",
    git(from, "write-tree"),
    ...(parent === null ? [] : ["-p", parent]),
    ...message.flatMap((paragraph) => ["-m", paragraph]),
  );
}

/** The refusal of a child that is not its source plus the build outputs alone, whatever deviates. */
const NOT_A_PACKAGE =
  /is not [0-9a-f]{40} plus lib\/index\.js and lib\/pkg\/, minus package\.json's preparation scripts, alone: its tree is [0-9a-f]{40}, the rebuilt one is [0-9a-f]{40} \(git diff [0-9a-f]{40} [0-9a-f]{40} lists what deviates\); /;

/** A hand-planted commit under a packaged commit's name, and the refusal every path (a rerun, the major) answers
 * with; the remedy tail differs per ref and is the caller's to check. */
export type PlantedPackage = (fx: Fixture) => { from: string; sha: string; error: RegExp };
export const PLANTED_PACKAGES: [string, PlantedPackage][] = [
  [
    "a child of another commit",
    (fx) => {
      const planted = plantCommit(
        fx,
        "planter",
        fx.mergeSha,
        fx.seedSha,
        builtFiles("packaged-bundle-bytes-1\n"),
      );
      return {
        ...planted,
        error: new RegExp(
          ` \\(${planted.sha}\\) has parent ${fx.seedSha}, so it is no package of ${fx.mergeSha} \\(a packaged commit is that commit's child\\); `,
        ),
      };
    },
  ],
  [
    "a root",
    (fx) => ({
      ...plantCommit(fx, "planter", fx.mergeSha, null, builtFiles("packaged-bundle-bytes-1\n")),
      error: /has no parent, so it is no package of/,
    }),
  ],
  [
    "a child carrying a file beyond the build outputs",
    (fx) => ({
      ...plantCommit(fx, "planter", fx.mergeSha, fx.mergeSha, {
        ...builtFiles("packaged-bundle-bytes-1\n"),
        "src/marker.ts": "export const marker = 666;\n",
      }),
      error: NOT_A_PACKAGE,
    }),
  ],
  [
    "a child whose package.json kept its preparation scripts",
    (fx) => ({
      ...plantCommit(fx, "planter", fx.mergeSha, fx.mergeSha, {
        ...builtFiles("packaged-bundle-bytes-1\n"),
        "package.json": manifestJson("2.1.0"),
      }),
      error: NOT_A_PACKAGE,
    }),
  ],
  [
    "a child carrying an empty subtree beyond the build outputs",
    (fx) => {
      // Invisible to a path diff (no path lives in an empty tree), so only tree identity catches it.
      const planted = plantCommit(
        fx,
        "planter",
        fx.mergeSha,
        fx.mergeSha,
        builtFiles("packaged-bundle-bytes-1\n"),
      );
      const emptyTree = execFileSync("git", ["hash-object", "-w", "-t", "tree", "--stdin"], {
        cwd: planted.from,
        input: "",
        encoding: "utf8",
      }).trim();
      const tree = execFileSync("git", ["mktree"], {
        cwd: planted.from,
        input: `${git(planted.from, "ls-tree", `${planted.sha}^{tree}`)}\n040000 tree ${emptyTree}\tempty\n`,
        encoding: "utf8",
      }).trim();
      return {
        from: planted.from,
        sha: git(planted.from, "commit-tree", tree, "-p", fx.mergeSha, "-m", "build: by hand"),
        error: NOT_A_PACKAGE,
      };
    },
  ],
  [
    "a child without the library build",
    (fx) => ({
      ...plantCommit(fx, "planter", fx.mergeSha, fx.mergeSha, {
        "lib/index.js": "packaged-bundle-bytes-1\n",
      }),
      error:
        /is not the tree [0-9a-f]{40} this checkout's build packages|does not carry a non-empty regular-file lib\/pkg\/index\.js \(no entry\)/,
    }),
  ],
  [
    "a child carrying the bundle as a symlink",
    (fx) => ({
      ...plantCommit(fx, "planter", fx.mergeSha, fx.mergeSha, {
        ...builtFiles("packaged-bundle-bytes-1\n"),
        "lib/index.js": { linkTo: "../src/marker.ts" },
      }),
      // A run with a fresh build holds the tag to its tree; one without holds it to the required regular files.
      error:
        /is not the tree [0-9a-f]{40} this checkout's build packages|does not carry a non-empty regular-file lib\/index\.js/,
    }),
  ],
];

/** A packaged commit as another run would mint it for `source` with `bundle`: its child, the pipeline's tree. */
export function rivalPackage(
  fx: Fixture,
  name: string,
  source: string,
  bundle: string,
): { from: string; sha: string } {
  return plantCommit(fx, name, source, source, builtFiles(bundle), ["build: by another run"]);
}

/** What the shim does to the pipeline's n-th push, before real git sees it. */
export type PushPlan =
  /** Force-push `sha` to `ref` first from the clone `from`; real git then judges the pipeline's push. */
  | { competitor: { from: string; sha: string; ref: string } }
  /** Run this shell first (a rival whose action depends on origin's state at that moment). */
  | { script: string }
  /** Replay a remote a file:// origin cannot play: this stderr, this exit status. */
  | { fail: { stderr: string; status: number } };

/** Run `body` with the shim playing `plans` against the pipeline's pushes, in order, and `afterLsRemote`'s shell
 * ONCE right after the first ls-remote whose arguments include `naming` (a rival landing between that read and the
 * write it informs); the pushes the pipeline attempted, as logged. */
export function withPushPlans(
  fx: Fixture,
  plans: (PushPlan | null)[],
  body: () => void,
  afterLsRemote?: { naming: string; script: string },
): string[][] {
  const plansDir = mkdtempSync(join(fx.root, "push-plans-"));
  if (afterLsRemote !== undefined) {
    writeFileSync(join(plansDir, "after-ls-remote.naming"), `${afterLsRemote.naming}\n`);
    writeFileSync(join(plansDir, "after-ls-remote.sh"), afterLsRemote.script);
  }
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

export const LATEST = "refs/tags/latest";
export const ANCHOR_PUSH = ["push", "origin", "HEAD:refs/heads/release-please--branches--main"];
/** The pipeline's pushes as the shim logs them: a create-once push, a lease-guarded move, a batch of deletions. */
export const createOf = (commit: string, ref: string): string[] => [
  "push",
  "origin",
  `${commit}:${ref}`,
];
export const moveOf = (ref: string, observed: string, commit: string): string[] => [
  "push",
  `--force-with-lease=${ref}:${observed}`,
  "origin",
  `${commit}:${ref}`,
];
export const deleteOf = (...refs: string[]): string[] => [
  "push",
  "origin",
  ...refs.map((ref) => `:${ref}`),
];
/** The commit a logged create push carried (its objects exist in the pushing clone). */
export const createdSha = (push: string[]): string => (push[2] ?? "").split(":")[0] ?? "";

/** Remotes a file:// origin cannot play, as git words them, replayed with the ref UNMOVED on origin, so none is a
 * lost compare-and-set: a pointer or anchor push throws on the first, a tag create tries again while the ref reads
 * absent and throws after the last. The pipeline judges origin's ref, never git's words; the stale-info wording is
 * the proof. A ruleset's refusal (GH013) takes the token's path and is not replayed. */
export const PERMANENT: [string, string][] = [
  [
    "a token without write access",
    "remote: Write access to repository not granted.\nfatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403\n",
  ],
  [
    "git's compare-and-set words while the ref stands where it was read",
    "To https://github.com/o/r.git\n ! [rejected]        0123abc -> latest (stale info)\n" +
      "error: failed to push some refs to 'https://github.com/o/r.git'\n",
  ],
];

/** Run the script's subcommand under this bun as the workflow does: stdout, stderr, and status as they were.
 * Asynchronous, so a registry served from the test process can answer the child. */
export async function subcommand(
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
