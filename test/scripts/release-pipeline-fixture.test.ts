import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageCommit } from "../../.github/scripts/release-pipeline/tags.js";
import {
  buildTagOf,
  buildTags,
  type Fixture,
  installReleasePipelineFixture,
  originHooks,
  seedFixture,
} from "./release-pipeline-fixture.js";

setDefaultTimeout(60_000);

/** Two variables a launcher can leave in the environment (git exports GIT_DIR to a hook); each redirects every git run below it. */
const LAUNCHER = ["GIT_CONFIG", "GIT_DIR"] as const;

/** What the suite itself was launched with, put back when the file ends. */
const launchedWith = new Map<string, string | undefined>();

/** The launcher's side: a config file and a repository, hand-written so no git runs before the fixture's seal. */
let launcher = "";
const launcherConfig = (): string => join(launcher, "launcher.gitconfig");
const launcherRepo = (): string => join(launcher, "launched-from.git");

/** The launcher's side as it was written. */
let written: Record<string, string | null> = {};

/** Every path under `dir` with its bytes, a directory as null. */
function snapshot(dir: string): Record<string, string | null> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .sort()
      .map((entry) => [
        entry,
        statSync(join(dir, entry)).isDirectory() ? null : readFileSync(join(dir, entry), "latin1"),
      ]),
  );
}

// Registered ahead of the fixture's own hooks, so the fixture starts in an environment that already redirects git.
beforeAll(() => {
  launcher = mkdtempSync(join(tmpdir(), "release-pipeline-launcher-"));
  writeFileSync(launcherConfig(), "[launcher]\n\tkept = true\n");
  mkdirSync(join(launcherRepo(), "objects"), { recursive: true });
  mkdirSync(join(launcherRepo(), "refs"));
  writeFileSync(join(launcherRepo(), "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(
    join(launcherRepo(), "config"),
    "[core]\n\trepositoryformatversion = 0\n\tbare = true\n",
  );
  written = snapshot(launcher);
  for (const name of LAUNCHER) {
    launchedWith.set(name, process.env[name]);
  }
  process.env.GIT_CONFIG = launcherConfig();
  process.env.GIT_DIR = launcherRepo();
});

installReleasePipelineFixture();

// Registered after the fixture's hooks, so it runs once the fixture ended: the launcher's variables are back.
afterAll(() => {
  try {
    expect({ config: process.env.GIT_CONFIG, dir: process.env.GIT_DIR }).toEqual({
      config: launcherConfig(),
      dir: launcherRepo(),
    });
  } finally {
    for (const [name, value] of launchedWith) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(launcher, { recursive: true, force: true });
  }
});

test("a fixture git command never writes into the repository the tests were launched from: with the launcher's GIT_DIR and GIT_CONFIG in the environment, both stay byte-identical while origin takes its own config and the pipeline's tag", () => {
  let fx: Fixture | undefined;
  let failure: unknown;
  try {
    fx = seedFixture();
    originHooks(fx, { "pre-receive": "exit 0\n" });
    packageCommit({ cwd: fx.work, sourceSha: fx.mergeSha });
  } catch (thrown) {
    failure = thrown;
  }
  expect(snapshot(launcher)).toEqual(written);
  expect(failure).toBeUndefined();
  if (fx === undefined) {
    return;
  }
  const originConfig = readFileSync(join(fx.origin, "config"), "utf8");
  expect(originConfig).toContain("[maintenance]\n\tauto = false\n");
  expect(originConfig).toContain(`\thooksPath = ${join(fx.root, "origin-hooks")}\n`);
  expect(buildTags(fx)).toEqual([buildTagOf(fx, fx.mergeSha)]);
});
