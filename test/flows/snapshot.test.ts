/**
 * The mode: snapshot flow over a routed client: the file form writes one
 * document and reports through the outputs and the summary, the dir form
 * writes one file per resolved target under the repos-dir layout, a redacted
 * target's values reach the file and nothing else, and every failure class
 * (denial, unwritable path, a name that would leave the directory, no
 * targets) ends as the documented result.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseRepoSlug } from "../../src/discovery/targets.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { failRun } from "../../src/flows/deliver.js";
import { REDACTED_NOTE } from "../../src/flows/redact.js";
import {
  concludeSnapshot,
  runSnapshot,
  SNAPSHOT_SCHEMA_URL,
  type SnapshotConfig,
} from "../../src/flows/snapshot.js";
import { collectingIo, type Io } from "../../src/io.js";
import { isPrivate, markPrivate } from "../../src/private.js";
import type { SectionKey } from "../../src/schema.js";
import { MockApi } from "../mock-api.js";
import { withTempDir } from "../temp-dir.js";

const repo = parseRepoSlug("o/r")._unsafeUnwrap();

/** `text` as a regex source matching itself literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Run a snapshot the way the action does: the finished run concludes, a problem fails the run. */
async function run(api: MockApi, cfg: SnapshotConfig, io: Io): Promise<number> {
  return (await runSnapshot(api, cfg, io)).match(
    (finished) => concludeSnapshot(io, finished),
    (problem) => failRun(io, problem),
  );
}

/** The selection that processes only `keys`. */
function only(...keys: SectionKey[]): SectionSelection {
  return SectionSelection.of({ only: keys })._unsafeUnwrap();
}

const BUG = { name: "bug", color: "d73a4a", description: "Something is broken" };
const DOCS = { name: "docs", color: "0075ca", description: "" };
const doc = (...labels: Array<typeof BUG>) => ({
  labels: { _undeclared: "delete", entries: labels },
});
const labelsRoute = (slug: string, labels: Array<typeof BUG>) => ({
  [`GET /repos/${slug}/labels?per_page=100&page=1`]: { data: labels },
});

/** An ISO-8601 UTC instant, the form the run's one moment is stated in. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** The run's one notice with its moment: the file carries none, so a re-snapshot is byte-identical. */
const TAKEN = {
  level: "notice" as const,
  line: expect.stringMatching(new RegExp(`^snapshot taken ${ISO_INSTANT.source.slice(1)}`)),
};

/** The summary's statement of the same moment. */
const TAKEN_LINE = expect.stringMatching(
  new RegExp(`^Snapshot taken ${ISO_INSTANT.source.slice(1, -1)}\\.$`),
);

/** The file opens with the schema pin, compared whole (a look-alike host is not the pin); no line dates it. */
function expectSnapshotHeader(written: string): void {
  const [pin, second] = written.split("\n");
  expect(pin).toBe(`# yaml-language-server: $schema=${SNAPSHOT_SCHEMA_URL}`);
  expect(second).not.toContain("taken");
}

type FileConfig = Extract<SnapshotConfig, { form: "file" }>;
type DirConfig = Extract<SnapshotConfig, { form: "dir" }>;

const fileCfg = (dir: string, overrides: Partial<FileConfig> = {}): FileConfig =>
  ({
    form: "file",
    repo,
    snapshotFile: join(dir, "out", "snapshot.yml"),
    onMissingPermission: "fail",
    sections: only("labels"),
    privateRepos: "show",
    selfSlug: "o/r",
    ...overrides,
  }) as FileConfig;

const dirCfg = (dir: string, overrides: Partial<DirConfig> = {}): DirConfig =>
  ({
    form: "dir",
    snapshotDir: join(dir, "snapshots"),
    reposInput: "o/a,o/b",
    reposDir: "",
    adminOwner: "admin",
    discoveryFilters: {
      visibility: "all",
      archived: "skip",
      forks: "include",
      affiliation: ["owner"],
      topics: [],
      exclude: [],
    },
    discoveryFiltersSet: [],
    onMissingPermission: "fail",
    sections: only("labels"),
    privateRepos: "redact",
    selfSlug: "admin/fleet",
    ...overrides,
  }) as DirConfig;

describe("runSnapshot, file form", () => {
  test("writes the document under its header and reports through the outputs, the log, and the summary", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi(labelsRoute("o/r", [BUG, DOCS]));
      const cfg = fileCfg(dir);
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(0);
      const written = readFileSync(cfg.snapshotFile, "utf8");
      expectSnapshotHeader(written);
      expect(parseYaml(written)).toEqual(doc(BUG, DOCS));
      expect(api.mutations()).toEqual([]);
      expect(collected.outputs).toEqual({
        result: "snapshot",
        "skipped-sections": "",
        "repos-result": "{}",
      });
      expect(collected.lines).toEqual([
        TAKEN,
        { line: `snapshot written to ${cfg.snapshotFile}` },
        { line: "result: snapshot" },
      ]);
      expect(collected.summary[0]?.split("\n")).toEqual([
        "## github-settings-as-code (snapshot)",
        "",
        `:white_check_mark: snapshot - written to ${cfg.snapshotFile}`,
        "",
        TAKEN_LINE,
        "",
        "| Section | Status | Detail |",
        "|---|---|---|",
        "| labels | :white_check_mark: snapshot | - |",
      ]);
    }));

  test("a private target other than the run's own closes through the fleet's seal: the summary hides the note, the log says nothing", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi({
        "GET /repos/o/r": { data: { private: true, visibility: "private" } },
        ...labelsRoute("o/r", [BUG]),
      });
      const cfg = fileCfg(dir, { privateRepos: "redact", selfSlug: "admin/fleet" });
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(0);
      expect(parseYaml(readFileSync(cfg.snapshotFile, "utf8"))).toEqual(doc(BUG));
      expect([...collected.io.masked()]).toEqual(["o/r"]);
      expect(collected.lines).toEqual([TAKEN, { line: "result: snapshot" }]);
      expect(collected.summary[0]?.split("\n")).toEqual([
        "## github-settings-as-code (snapshot)",
        "",
        `:white_check_mark: snapshot - ${REDACTED_NOTE}`,
        "",
        TAKEN_LINE,
        "",
        "| Section | Status | Detail |",
        "|---|---|---|",
        "| labels | :white_check_mark: snapshot | hidden (private repository) |",
      ]);
      expect(collected.summary[0]).not.toContain(cfg.snapshotFile);
    }));

  test("a private target that fails gets the fleet's one closed-value line, numbered as a fleet of one", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      // No labels route: the read answers 404, the denial that fails the target under the fail policy.
      const api = new MockApi({
        "GET /repos/o/r": { data: { private: true, visibility: "private" } },
      });
      const cfg = fileCfg(dir, { privateRepos: "redact", selfSlug: "admin/fleet" });
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(1);
      expect(existsSync(cfg.snapshotFile)).toBe(false);
      expect(collected.lines).toEqual([
        TAKEN,
        { level: "error", line: `private repository #1: failed - labels. ${REDACTED_NOTE}` },
        { line: "result: failed" },
      ]);
      expect(collected.summary[0]).toContain(
        "| labels | :x: failed | hidden (private repository) |",
      );
      expect(collected.summary[0]).not.toContain("/repos/o/r/labels");
    }));

  test("a denied section is skipped under warn: partial, the file omits it, the header and the outputs say so", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      // No variables route: the read answers 404, the fine-grained denial.
      const api = new MockApi(labelsRoute("o/r", [BUG]));
      const cfg = fileCfg(dir, {
        onMissingPermission: "warn",
        sections: only("labels", "actions_variables", "check_suite_preferences"),
      });
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(0);
      const written = readFileSync(cfg.snapshotFile, "utf8");
      expect(parseYaml(written)).toEqual(doc(BUG));
      expect(written).toContain(
        "# check_suite_preferences: GitHub exposes no read endpoint for this section, so there is nothing to snapshot; apply re-asserts the declared value on every run\n",
      );
      expect(written).toMatch(
        /^# actions_variables: the token was denied GET \/repos\/o\/r\/actions\/variables/m,
      );
      expect(collected.outputs).toEqual({
        result: "partial",
        "skipped-sections": "actions_variables",
        "repos-result": "{}",
      });
      expect(collected.lines.map((entry) => `${entry.level ?? "log"}: ${entry.line}`)).toEqual([
        expect.stringMatching(/^notice: snapshot taken /),
        expect.stringMatching(/^warning: actions_variables: skipped - the token was denied GET/),
        "notice: not snapshotted: check_suite_preferences - snapshot does not read these sections back, so the file omits them (the header says why); declare them by hand if they should be managed",
        `log: snapshot written to ${cfg.snapshotFile}`,
        "log: result: partial",
      ]);
      expect(collected.summary[0]).toContain(":warning: partial - written to");
      expect(collected.summary[0]).toContain("| actions_variables | :fast_forward: skipped |");
      expect(collected.summary[0]).toContain(
        "| check_suite_preferences | :fast_forward: unsupported |",
      );
    }));

  test("a denied section under fail fails the run and writes no file", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi(labelsRoute("o/r", [BUG]));
      const cfg = fileCfg(dir, { sections: only("labels", "actions_variables") });
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(1);
      expect(existsSync(cfg.snapshotFile)).toBe(false);
      expect(collected.outputs).toEqual({
        result: "failed",
        "skipped-sections": "",
        "repos-result": "{}",
      });
      expect(collected.lines).toEqual([
        TAKEN,
        {
          level: "error",
          line: expect.stringMatching(
            /^actions_variables: not snapshotted - the token was denied GET/,
          ),
        },
        { line: "result: failed" },
      ]);
      expect(collected.summary[0]).toContain(
        ":x: failed - the snapshot failed, so no file was written",
      );
    }));

  test("an unwritable snapshot-file fails the run naming the input", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi(labelsRoute("o/r", [BUG]));
      writeFileSync(join(dir, "blocker"), "");
      const cfg = fileCfg(dir, { snapshotFile: join(dir, "blocker", "snapshot.yml") });
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(1);
      expect(collected.outputs.result).toBe("failed");
      // The run's moment leads; the write failure is the first line about the target.
      const [, first] = collected.lines;
      expect(first?.level).toBe("error");
      // The path is compared as text, never as a pattern; the OS error code sits between.
      expect(first?.line.startsWith(`cannot write the snapshot to ${cfg.snapshotFile}: `)).toBe(
        true,
      );
      expect(first?.line).toMatch(/E(EXIST|NOTDIR)/);
      expect(
        first?.line.endsWith('. Check that the "snapshot-file" input names a writable path'),
      ).toBe(true);
    }));
});

function settingsRefusal(snapshotFile: string): string {
  return (
    `the "snapshot-file" input "${snapshotFile}" is the settings file apply and check read ` +
    "(.github/settings.yml): the snapshot would overwrite the document you author. Write it to " +
    "another path and copy it over deliberately"
  );
}

/** The refusal a snapshot-dir gets when it is not disjoint from the repos-dir. */
function disjointRefusal(snapshotDir: string, reposDir: string): string {
  return (
    `the "snapshot-dir" input "${snapshotDir}" is, contains, or sits inside the "repos-dir" ` +
    `"${reposDir}": the snapshots are written in the repos-dir layout, so they would overwrite ` +
    "the central settings files or be read back as central files. Write them to a directory " +
    "outside the repos-dir and copy them over deliberately"
  );
}

describe("runSnapshot writes through a staging file", () => {
  const unwritable = (path: string, input: "snapshot-file" | "snapshot-dir", os: string) => ({
    level: "error" as const,
    line: `cannot write the snapshot to ${path}: ${os}. Check that the "${input}" input names a writable path`,
  });

  test("the user's own `<snapshot-file>.tmp` sibling is never touched: the write stages under a name of its own", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi(labelsRoute("o/r", [BUG]));
      const cfg = fileCfg(dir);
      const sibling = `${cfg.snapshotFile}.tmp`;
      mkdirSync(dirname(cfg.snapshotFile), { recursive: true });
      writeFileSync(cfg.snapshotFile, "labels: []\n");
      // A directory with content at the `.tmp` sibling: a writer staging THERE would remove it or fail on it.
      mkdirSync(sibling);
      writeFileSync(join(sibling, "keep"), "user data\n");
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(0);
      expect(collected.lines).toEqual([
        TAKEN,
        { line: `snapshot written to ${cfg.snapshotFile}` },
        { line: "result: snapshot" },
      ]);
      expect(parseYaml(readFileSync(cfg.snapshotFile, "utf8"))).toEqual(doc(BUG));
      expect(readFileSync(join(sibling, "keep"), "utf8")).toBe("user data\n");
      // No staging file of the run's own is left beside the destination.
      expect(readdirSync(dirname(cfg.snapshotFile)).sort()).toEqual([
        basename(cfg.snapshotFile),
        basename(sibling),
      ]);
    }));

  test("a rename that fails removes the staging file, fails only that target, and leaves the destination as it was", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi({
        "GET /repos/o/a": { data: { private: false } },
        "GET /repos/o/b": { data: { private: false } },
        ...labelsRoute("o/a", [BUG]),
        ...labelsRoute("o/b", [DOCS]),
      });
      const cfg = dirCfg(dir);
      const fileA = join(cfg.snapshotDir, "o", "a.yml");
      const fileB = join(cfg.snapshotDir, "o", "b.yml");
      // A directory holding a file at o/a's destination lets the staging write succeed and the rename fail.
      mkdirSync(fileA, { recursive: true });
      writeFileSync(join(fileA, "keep"), "authored\n");
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(1);
      expect(collected.outputs).toEqual({
        "skipped-sections": "",
        result: "failed",
        "repos-result": JSON.stringify({
          "o/a": { result: "failed", source: "remote", "skipped-sections": [] },
          "o/b": { result: "snapshot", source: "remote", "skipped-sections": [] },
        }),
      });
      const { level, line } = unwritable(
        fileA,
        "snapshot-dir",
        `Error: EISDIR: illegal operation on a directory, rename '<staging>' -> '${fileA}'`,
      );
      // The staging name carries the pid and random bytes, so the line is matched with that piece wild.
      const [head = "", tail = ""] = line.split("<staging>");
      const stagingRe = `${escapeRegExp(join(cfg.snapshotDir, "o"))}/\\.gsac-\\d+-[0-9a-f]{8}\\.tmp`;
      expect(collected.lines).toEqual([
        TAKEN,
        {
          level,
          line: expect.stringMatching(
            new RegExp(`^o/a: ${escapeRegExp(head)}${stagingRe}${escapeRegExp(tail)}$`),
          ),
        },
        { line: `o/b: snapshot written to ${fileB}` },
        { line: "result: failed" },
      ]);
      // No staging file of the run's own is left beside either destination.
      expect(readdirSync(join(cfg.snapshotDir, "o")).sort()).toEqual(["a.yml", "b.yml"]);
      expect(readFileSync(join(fileA, "keep"), "utf8")).toBe("authored\n");
      expect(parseYaml(readFileSync(fileB, "utf8"))).toEqual(doc(DOCS));
      expect(collected.summary[0]?.split("\n").slice(0, 10)).toEqual([
        "## github-settings-as-code (snapshot, 2 repositories)",
        "",
        `1 of 2 snapshots written under ${cfg.snapshotDir}.`,
        "",
        TAKEN_LINE,
        "",
        "| Repository | Source | Result | File |",
        "|---|---|---|---|",
        "| o/a | remote | :x: failed | - |",
        `| o/b | remote | :white_check_mark: snapshot | ${fileB} |`,
      ]);
    }));
});

describe("runSnapshot refuses a destination that would overwrite an authored file", () => {
  test.each<[string, (dir: string) => SnapshotConfig, string]>([
    [
      "snapshot-file naming the settings file apply reads",
      (dir) => fileCfg(dir, { snapshotFile: "./.github/settings.yml" }),
      settingsRefusal("./.github/settings.yml"),
    ],
    [
      "snapshot-dir equal to the repos-dir",
      (dir) => dirCfg(dir, { snapshotDir: "./repos", reposDir: "repos" }),
      disjointRefusal("./repos", "repos"),
    ],
    [
      "snapshot-dir above the repos-dir, where a bare <name>.yml would be overwritten",
      (dir) => dirCfg(dir, { snapshotDir: "central", reposDir: "central/acme" }),
      disjointRefusal("central", "central/acme"),
    ],
    [
      "snapshot-dir below the repos-dir under a name starting with two dots, which is still below it",
      (dir) => dirCfg(dir, { snapshotDir: "central/..snapshots", reposDir: "central" }),
      disjointRefusal("central/..snapshots", "central"),
    ],
    [
      "snapshot-dir below the repos-dir, where the next run would read the snapshots as central files",
      (dir) => dirCfg(dir, { snapshotDir: "central/snapshots", reposDir: "central" }),
      disjointRefusal("central/snapshots", "central"),
    ],
  ])("%s fails before any API call or write", (_case, cfg, message) =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi({});
      const collected = collectingIo();
      expect(await run(api, cfg(dir), collected.io)).toBe(1);
      expect(api.calls).toEqual([]);
      expect(collected.outputs).toEqual({
        result: "failed",
        "skipped-sections": "",
        "repos-result": "{}",
      });
      expect(collected.lines).toEqual([
        { level: "error", line: message },
        { line: "result: failed" },
      ]);
    }),
  );
});

function tempFoldsCase(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "snapshot-case-probe-"));
  try {
    writeFileSync(join(probe, "a"), "");
    return existsSync(join(probe, "A"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

describe("runSnapshot refuses a destination that is an authored path under another name", () => {
  const AUTHORED = "labels:\n  - name: $NAME\n";
  type Alias = {
    /** The authored file the alias reaches, relative to the working directory. */
    authored: string;
    /** Makes the alias reach the authored path; a case alias needs nothing. */
    link?: (dir: string) => void;
    cfg: (dir: string) => SnapshotConfig;
    message: string;
  };

  /** Runs in `dir`, since the inputs and the settings-file constant resolve against the working directory. */
  async function refuses(dir: string, { authored, link, cfg, message }: Alias): Promise<void> {
    const authoredPath = join(dir, authored);
    mkdirSync(dirname(authoredPath), { recursive: true });
    writeFileSync(authoredPath, AUTHORED);
    link?.(dir);
    const api = new MockApi({
      "GET /repos/o/r": { data: { private: false } },
      ...labelsRoute("o/r", [BUG]),
    });
    const collected = collectingIo();
    const previous = process.cwd();
    process.chdir(dir);
    try {
      expect(await run(api, cfg(dir), collected.io)).toBe(1);
    } finally {
      process.chdir(previous);
    }
    expect(api.calls).toEqual([]);
    expect(collected.outputs).toEqual({
      result: "failed",
      "skipped-sections": "",
      "repos-result": "{}",
    });
    expect(collected.lines).toEqual([
      { level: "error", line: message },
      { line: "result: failed" },
    ]);
    expect(readFileSync(authoredPath, "utf8")).toBe(AUTHORED);
  }

  const settingsFile = join(".github", "settings.yml");
  const central = join("central", "o", "r.yml");

  describe.skipIf(!tempFoldsCase())("a case alias, on a filesystem that folds case", () => {
    test.each<[string, Alias]>([
      [
        "snapshot-file spelled .GITHUB/settings.yml",
        {
          authored: settingsFile,
          cfg: (dir) => fileCfg(dir, { snapshotFile: join(".GITHUB", "settings.yml") }),
          message: settingsRefusal(join(".GITHUB", "settings.yml")),
        },
      ],
      [
        "snapshot-dir spelled CENTRAL over the repos-dir central",
        {
          authored: central,
          cfg: (dir) => dirCfg(dir, { snapshotDir: "CENTRAL", reposDir: "central" }),
          message: disjointRefusal("CENTRAL", "central"),
        },
      ],
      [
        "a snapshot-dir that does not exist yet below the case-aliased repos-dir",
        {
          authored: central,
          cfg: (dir) =>
            dirCfg(dir, { snapshotDir: join("CENTRAL", "snapshots"), reposDir: "central" }),
          message: disjointRefusal(join("CENTRAL", "snapshots"), "central"),
        },
      ],
    ])("%s", (_case, alias) => withTempDir("snapshot-flow-", (dir) => refuses(dir, alias)));
  });

  test.each<[string, Alias]>([
    [
      "snapshot-file naming a symlink to the settings file",
      {
        authored: settingsFile,
        link: (cwd) => symlinkSync(join(cwd, settingsFile), join(cwd, "snapshot.yml")),
        cfg: (dir) => fileCfg(dir, { snapshotFile: "snapshot.yml" }),
        message: settingsRefusal("snapshot.yml"),
      },
    ],
    [
      "snapshot-dir naming a symlink to the repos-dir",
      {
        authored: central,
        link: (cwd) => symlinkSync(join(cwd, "central"), join(cwd, "mirror")),
        cfg: (dir) => dirCfg(dir, { snapshotDir: "mirror", reposDir: "central" }),
        message: disjointRefusal("mirror", "central"),
      },
    ],
    [
      "snapshot-dir reaching that symlink through a directory that does not exist yet and ..",
      {
        authored: central,
        link: (cwd) => symlinkSync(join(cwd, "central"), join(cwd, "mirror")),
        cfg: (dir) =>
          dirCfg(dir, { snapshotDir: ["missing", "..", "mirror"].join(sep), reposDir: "central" }),
        message: disjointRefusal(["missing", "..", "mirror"].join(sep), "central"),
      },
    ],
    [
      "repos-dir spelled as a symlink inside the snapshot-dir, so a target owned like the link writes through it",
      {
        authored: join("authored", "r.yml"),
        link: (cwd) => {
          mkdirSync(join(cwd, "out"));
          symlinkSync(join("..", "authored"), join(cwd, "out", "central"));
        },
        cfg: (dir) =>
          dirCfg(dir, {
            snapshotDir: "out",
            reposDir: join("out", "central"),
            adminOwner: "central",
          }),
        message: disjointRefusal("out", join("out", "central")),
      },
    ],
    [
      "snapshot-file leaving a symlink's target with .., which the filesystem resolves to the settings file",
      {
        authored: settingsFile,
        link: (cwd) => {
          mkdirSync(join(cwd, ".github", "inner"));
          symlinkSync(join(".github", "inner"), join(cwd, "link"));
        },
        cfg: (dir) => fileCfg(dir, { snapshotFile: ["link", "..", "settings.yml"].join(sep) }),
        message: settingsRefusal(["link", "..", "settings.yml"].join(sep)),
      },
    ],
  ])("%s", (_case, alias) => withTempDir("snapshot-flow-", (dir) => refuses(dir, alias)));

  type Carried = {
    authored: string;
    link: (cwd: string) => void;
    cfg: (dir: string) => DirConfig;
    /** Every target the run resolves, central first, with the file it would write and why it must not. */
    targets: Array<{
      slug: string;
      source: "central" | "remote";
      path: string;
      reason: (cwd: string) => string;
    }>;
  };
  const real = (cwd: string, ...parts: string[]) => realpathSync.native(join(cwd, ...parts));
  const ontoAuthored = (landing: string) =>
    `the filesystem carries it to ${landing}, an authored settings file. Write the snapshots to a directory that leads to no authored file`;
  const intoReposDir = (landing: string, reposDir: string) =>
    `the filesystem carries it to ${landing}, inside the "repos-dir" input "${reposDir}". Write the snapshots to a directory that leads to no central file`;

  // Neither input names the other under any spelling; only the written path, followed by the filesystem, does.
  test.each<[string, Carried]>([
    [
      "links under the snapshot-dir lead a target's file into the repos-dir",
      {
        authored: join("authored", "r.yml"),
        link: (cwd) => {
          mkdirSync(join(cwd, "out"));
          symlinkSync("out", join(cwd, "outlink"));
          symlinkSync(join("..", "authored"), join(cwd, "out", "central"));
        },
        cfg: (dir) =>
          dirCfg(dir, {
            snapshotDir: "outlink",
            reposInput: "",
            reposDir: join("out", "central"),
            adminOwner: "central",
            privateRepos: "show",
          }),
        targets: [
          {
            slug: "central/r",
            source: "central",
            path: join("outlink", "central", "r.yml"),
            reason: (cwd) => ontoAuthored(real(cwd, "authored", "r.yml")),
          },
        ],
      },
    ],
    [
      "an owner spelled .github under a snapshot-dir of . names the settings file",
      {
        authored: settingsFile,
        link: () => {},
        cfg: (dir) =>
          dirCfg(dir, { snapshotDir: ".", reposInput: ".github/settings", privateRepos: "show" }),
        targets: [
          {
            slug: ".github/settings",
            source: "remote",
            path: settingsFile,
            reason: (cwd) => ontoAuthored(real(cwd, ".github", "settings.yml")),
          },
        ],
      },
    ],
    [
      "a link under the repos-dir into the snapshot-dir, so discovery read the authored file where the snapshot writes",
      {
        authored: join("out", "o", "r.yml"),
        link: (cwd) => {
          mkdirSync(join(cwd, "central"));
          symlinkSync(join("..", "out", "o"), join(cwd, "central", "o"));
        },
        cfg: (dir) =>
          dirCfg(dir, {
            snapshotDir: "out",
            reposDir: "central",
            reposInput: "",
            privateRepos: "show",
          }),
        targets: [
          {
            slug: "o/r",
            source: "central",
            path: join("out", "o", "r.yml"),
            reason: (cwd) => ontoAuthored(real(cwd, "out", "o", "r.yml")),
          },
        ],
      },
    ],
    [
      "a link under the snapshot-dir into the repos-dir: the central file is authored, the remote target's new file would be read back as central",
      {
        authored: join("central", "o", "r.yml"),
        link: (cwd) => {
          mkdirSync(join(cwd, "out"));
          symlinkSync(join("..", "central", "o"), join(cwd, "out", "o"));
        },
        cfg: (dir) =>
          dirCfg(dir, {
            snapshotDir: "out",
            reposDir: "central",
            reposInput: "o/x",
            privateRepos: "show",
          }),
        targets: [
          {
            slug: "o/r",
            source: "central",
            path: join("out", "o", "r.yml"),
            reason: (cwd) => ontoAuthored(real(cwd, "central", "o", "r.yml")),
          },
          {
            slug: "o/x",
            source: "remote",
            path: join("out", "o", "x.yml"),
            reason: (cwd) => intoReposDir(join(real(cwd, "central", "o"), "x.yml"), "central"),
          },
        ],
      },
    ],
  ])("%s: those targets fail alone, before any read", (_case, carried) =>
    withTempDir("snapshot-flow-", async (dir) => {
      const authoredPath = join(dir, carried.authored);
      mkdirSync(dirname(authoredPath), { recursive: true });
      writeFileSync(authoredPath, AUTHORED);
      carried.link(dir);
      const api = new MockApi({});
      const collected = collectingIo();
      const previous = process.cwd();
      process.chdir(dir);
      try {
        expect(await run(api, carried.cfg(dir), collected.io)).toBe(1);
      } finally {
        process.chdir(previous);
      }
      expect(api.calls).toEqual([]);
      expect(collected.outputs).toEqual({
        "skipped-sections": "",
        result: "failed",
        "repos-result": JSON.stringify(
          Object.fromEntries(
            carried.targets.map((t) => [
              t.slug,
              { result: "failed", source: t.source, "skipped-sections": [] },
            ]),
          ),
        ),
      });
      expect(collected.lines).toEqual([
        TAKEN,
        ...carried.targets.map((t) => ({
          level: "error" as const,
          line: `${t.slug}: cannot write the snapshot to ${t.path}: ${t.reason(dir)}`,
        })),
        { line: "result: failed" },
      ]);
      expect(readFileSync(authoredPath, "utf8")).toBe(AUTHORED);
      for (const t of carried.targets) {
        expect(existsSync(join(dir, `${t.path}.tmp`))).toBe(false);
      }
    }),
  );
});

describe("runSnapshot, dir form", () => {
  test("a snapshot-dir spelled through a link and .. lands where join puts it, beside the link, and is not refused", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      // The write collapses "link/.." before the OS sees it; the guard must judge the same place, not link's target.
      mkdirSync(join(dir, "central", "o"), { recursive: true });
      mkdirSync(join(dir, "central", "inner"));
      writeFileSync(join(dir, "central", "o", "r.yml"), "labels: []\n");
      symlinkSync(join("central", "inner"), join(dir, "link"));
      const api = new MockApi(labelsRoute("o/r", [BUG]));
      const cfg = dirCfg(dir, {
        snapshotDir: ["link", "..", "snapshots"].join(sep),
        reposDir: "central",
        reposInput: "",
        privateRepos: "show",
      });
      const collected = collectingIo();
      const previous = process.cwd();
      process.chdir(dir);
      try {
        expect(await run(api, cfg, collected.io)).toBe(0);
      } finally {
        process.chdir(previous);
      }
      expect(parseYaml(readFileSync(join(dir, "snapshots", "o", "r.yml"), "utf8"))).toEqual(
        doc(BUG),
      );
      expect(existsSync(join(dir, "central", "snapshots"))).toBe(false);
      expect(readFileSync(join(dir, "central", "o", "r.yml"), "utf8")).toBe("labels: []\n");
      expect(collected.outputs).toEqual({
        "skipped-sections": "",
        result: "snapshot",
        "repos-result": JSON.stringify({
          "o/r": { result: "snapshot", source: "central", "skipped-sections": [] },
        }),
      });
      expect(collected.lines).toEqual([
        TAKEN,
        { line: `o/r: snapshot written to ${join(cfg.snapshotDir, "o", "r.yml")}` },
        { line: "result: snapshot" },
      ]);
    }));

  test("two targets carried to one file by an operator link fail the second, naming the first; the first's file stands", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi({
        "GET /repos/alice/r": { data: { private: false } },
        "GET /repos/bob/r": { data: { private: false } },
        ...labelsRoute("alice/r", [BUG]),
        ...labelsRoute("bob/r", [DOCS]),
      });
      const cfg = dirCfg(dir, { reposInput: "alice/r,bob/r" });
      // `snapshots/bob -> snapshots/alice`: bob/r's file lands on alice/r's, and a last-writer-wins would report both
      // written. alice/r's destination is itself a link to an older file: the rename replaces the LINK, so the claim
      // is the leaf under the real directory, not the old file the link pointed at, and old/r.yml stays as it was.
      mkdirSync(join(cfg.snapshotDir, "alice"), { recursive: true });
      symlinkSync("alice", join(cfg.snapshotDir, "bob"));
      mkdirSync(join(dir, "old"));
      writeFileSync(join(dir, "old", "r.yml"), "labels: []\n");
      symlinkSync(join("..", "..", "old", "r.yml"), join(cfg.snapshotDir, "alice", "r.yml"));
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(1);
      expect(collected.lines).toEqual([
        TAKEN,
        { line: `alice/r: snapshot written to ${join(cfg.snapshotDir, "alice", "r.yml")}` },
        {
          level: "error",
          line:
            `bob/r: cannot write the snapshot to ${join(cfg.snapshotDir, "bob", "r.yml")}: the filesystem carries it to ` +
            'the file this run already claimed for alice/r. Remove the link under the "snapshot-dir" input that folds ' +
            "the two owners together, so each target has a file of its own",
        },
        { line: "result: failed" },
      ]);
      expect(collected.outputs).toEqual({
        "skipped-sections": "",
        result: "failed",
        "repos-result": JSON.stringify({
          "alice/r": { result: "snapshot", source: "remote", "skipped-sections": [] },
          "bob/r": { result: "failed", source: "remote", "skipped-sections": [] },
        }),
      });
      expect(parseYaml(readFileSync(join(cfg.snapshotDir, "alice", "r.yml"), "utf8"))).toEqual(
        doc(BUG),
      );
      expect(readdirSync(join(cfg.snapshotDir, "alice"))).toEqual(["r.yml"]);
      expect(readFileSync(join(dir, "old", "r.yml"), "utf8")).toBe("labels: []\n");
    }));

  test("a destination that was a link to another owner's file claims only itself: that owner's own target still writes", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      // alice/r.yml -> ../old/r.yml before the run; the rename replaces the link, so old/r.yml is not alice's file and
      // the target old/r keeps its own.
      const api = new MockApi({
        "GET /repos/alice/r": { data: { private: false } },
        "GET /repos/old/r": { data: { private: false } },
        ...labelsRoute("alice/r", [BUG]),
        ...labelsRoute("old/r", [DOCS]),
      });
      const cfg = dirCfg(dir, { reposInput: "alice/r,old/r" });
      mkdirSync(join(cfg.snapshotDir, "alice"), { recursive: true });
      mkdirSync(join(cfg.snapshotDir, "old"));
      writeFileSync(join(cfg.snapshotDir, "old", "r.yml"), "labels: []\n");
      symlinkSync(join("..", "old", "r.yml"), join(cfg.snapshotDir, "alice", "r.yml"));
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(0);
      expect(collected.lines).toEqual([
        TAKEN,
        { line: `alice/r: snapshot written to ${join(cfg.snapshotDir, "alice", "r.yml")}` },
        { line: `old/r: snapshot written to ${join(cfg.snapshotDir, "old", "r.yml")}` },
        { line: "result: snapshot" },
      ]);
      expect(parseYaml(readFileSync(join(cfg.snapshotDir, "alice", "r.yml"), "utf8"))).toEqual(
        doc(BUG),
      );
      expect(parseYaml(readFileSync(join(cfg.snapshotDir, "old", "r.yml"), "utf8"))).toEqual(
        doc(DOCS),
      );
    }));

  test("two targets whose leaves differ only in case are one file on a case-insensitive filesystem: the second is refused", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      // Slugs dedupe case-insensitively, so the alias needs two owners folded by a link and leaves spelled apart:
      // alice/R writes alice/R.yml, bob/r reaches the same directory through the link with the leaf r.yml. The
      // filesystem's own name for that path (realpath, on-disk case) is the first's file, so the referent name
      // catches what the rename target cannot; in either order.
      writeFileSync(join(dir, "Probe"), "");
      const caseInsensitive = existsSync(join(dir, "probe"));
      for (const [first, second] of [
        ["alice/R", "bob/r"],
        ["bob/r", "alice/R"],
      ] as const) {
        const api = new MockApi({
          "GET /repos/alice/R": { data: { private: false } },
          "GET /repos/bob/r": { data: { private: false } },
          ...labelsRoute("alice/R", [BUG]),
          ...labelsRoute("bob/r", [DOCS]),
        });
        const cfg = dirCfg(dir, {
          reposInput: `${first},${second}`,
          snapshotDir: join(dir, `snapshots-${first.replace("/", "-")}`),
        });
        mkdirSync(join(cfg.snapshotDir, "alice"), { recursive: true });
        symlinkSync("alice", join(cfg.snapshotDir, "bob"));
        const collected = collectingIo();
        expect(await run(api, cfg, collected.io)).toBe(caseInsensitive ? 1 : 0);
        const written = readdirSync(join(cfg.snapshotDir, "alice"));
        if (caseInsensitive) {
          expect(collected.lines[2]).toEqual({
            level: "error",
            line: expect.stringMatching(
              new RegExp(
                `^${escapeRegExp(second)}: cannot write the snapshot to .*: the filesystem carries it to the file this run already claimed for ${escapeRegExp(first)}\\. `,
              ),
            ),
          });
          expect(written).toHaveLength(1);
          expect(
            parseYaml(readFileSync(join(cfg.snapshotDir, "alice", written[0] ?? ""), "utf8")),
          ).toEqual(doc(first === "alice/R" ? BUG : DOCS));
        } else {
          expect(written.sort()).toEqual(["R.yml", "r.yml"]);
        }
      }
    }));

  test("writes one <owner>/<name>.yml per resolved target and publishes the per-target rollup", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi({
        "GET /repos/o/a": { data: { private: false } },
        "GET /repos/o/b": { data: { private: false } },
        ...labelsRoute("o/a", [BUG]),
        ...labelsRoute("o/b", [DOCS]),
      });
      const cfg = dirCfg(dir);
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(0);
      const fileA = join(cfg.snapshotDir, "o", "a.yml");
      const fileB = join(cfg.snapshotDir, "o", "b.yml");
      expectSnapshotHeader(readFileSync(fileA, "utf8"));
      expect(parseYaml(readFileSync(fileA, "utf8"))).toEqual(doc(BUG));
      expect(parseYaml(readFileSync(fileB, "utf8"))).toEqual(doc(DOCS));
      expect(api.mutations()).toEqual([]);
      expect(collected.outputs).toEqual({
        "skipped-sections": "",
        result: "snapshot",
        "repos-result": JSON.stringify({
          "o/a": { result: "snapshot", source: "remote", "skipped-sections": [] },
          "o/b": { result: "snapshot", source: "remote", "skipped-sections": [] },
        }),
      });
      expect(collected.lines).toEqual([
        TAKEN,
        { line: `o/a: snapshot written to ${fileA}` },
        { line: `o/b: snapshot written to ${fileB}` },
        { line: "result: snapshot" },
      ]);
      expect(collected.summary[0]?.split("\n")).toEqual([
        "## github-settings-as-code (snapshot, 2 repositories)",
        "",
        `Snapshots written under ${cfg.snapshotDir}.`,
        "",
        TAKEN_LINE,
        "",
        "| Repository | Source | Result | File |",
        "|---|---|---|---|",
        `| o/a | remote | :white_check_mark: snapshot | ${fileA} |`,
        `| o/b | remote | :white_check_mark: snapshot | ${fileB} |`,
        "",
        "### o/a (snapshot)",
        "",
        `written to ${fileA}`,
        "",
        "| Section | Status | Detail |",
        "|---|---|---|",
        "| labels | :white_check_mark: snapshot | - |",
        "",
        "### o/b (snapshot)",
        "",
        `written to ${fileB}`,
        "",
        "| Section | Status | Detail |",
        "|---|---|---|",
        "| labels | :white_check_mark: snapshot | - |",
      ]);
    }));

  test("a redacted target's values reach its file and nothing else: the slug is masked, the public view shows the placeholder", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi({
        "GET /repos/o/a": { data: { private: false } },
        "GET /repos/o/p": { data: { private: true, visibility: "private" } },
        ...labelsRoute("o/a", [BUG]),
        ...labelsRoute("o/p", [{ name: "secret-project", color: "000000", description: "hush" }]),
      });
      const cfg = dirCfg(dir, { reposInput: "o/a,o/p" });
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(0);
      expect(parseYaml(readFileSync(join(cfg.snapshotDir, "o", "p.yml"), "utf8"))).toEqual(
        doc({ name: "secret-project", color: "000000", description: "hush" }),
      );
      expect([...collected.io.masked()]).toEqual(["o/p"]);
      const publicText = [
        ...collected.lines.map((entry) => entry.line),
        ...collected.summary,
        ...Object.values(collected.outputs),
      ].join("\n");
      for (const needle of ["o/p", "p.yml", "secret-project", "hush"]) {
        expect(publicText, `"${needle}" reached a public surface`).not.toContain(needle);
      }
      expect(collected.outputs).toEqual({
        result: "snapshot",
        "skipped-sections": "",
        "repos-result": JSON.stringify({
          "o/a": { result: "snapshot", source: "remote", "skipped-sections": [] },
          "private repository #1": { result: "snapshot", source: "remote", "skipped-sections": [] },
        }),
      });
      expect(collected.summary[0]).toContain(
        "| private repository #1 | remote | :white_check_mark: snapshot | hidden (private repository) |",
      );
      expect(collected.summary[0]).toContain(
        "### private repository #1 (snapshot)\n\ndetails hidden: the repository is private or internal.",
      );
      expect(collected.summary[0]).toContain(
        "| labels | :white_check_mark: snapshot | hidden (private repository) |",
      );
    }));

  test("a redacted target that fails closes sealed with its transcript and speaks the fleet's one closed-value line", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      // No labels route for o/p: the read answers 404, the denial that fails the target under the fail policy.
      const api = new MockApi({
        "GET /repos/o/a": { data: { private: false } },
        "GET /repos/o/p": { data: { private: true, visibility: "private" } },
        ...labelsRoute("o/a", [BUG]),
      });
      const cfg = dirCfg(dir, { reposInput: "o/a,o/p" });
      const collected = collectingIo();
      const finished = (await runSnapshot(api, cfg, collected.io))._unsafeUnwrap();
      const hidden = finished.form === "dir" ? finished.targets[1] : undefined;
      expect(hidden?.display).toBe("private repository #1");
      expect(isPrivate(hidden?.detail)).toBe(true);
      // The engine's denial line was captured, not emitted: it travels sealed beside the outcome and the note.
      expect(hidden?.detail).toEqual(
        markPrivate({
          slug: "o/p",
          outcomes: [
            {
              key: "labels",
              status: "failed",
              detail: [expect.stringMatching(/^the token was denied GET \/repos\/o\/p\/labels/)],
            },
          ],
          note: "the snapshot failed, so no file was written",
          file: undefined,
          transcript: [
            {
              level: "error",
              line: expect.stringMatching(
                /^labels: not snapshotted - the token was denied GET \/repos\/o\/p\/labels/,
              ),
            },
          ],
        }),
      );
      expect(concludeSnapshot(collected.io, finished)).toBe(1);
      expect(existsSync(join(cfg.snapshotDir, "o", "p.yml"))).toBe(false);
      expect(collected.lines).toEqual([
        TAKEN,
        { line: `o/a: snapshot written to ${join(cfg.snapshotDir, "o", "a.yml")}` },
        { level: "error", line: `private repository #1: failed - labels. ${REDACTED_NOTE}` },
        { line: "result: failed" },
      ]);
      // Nothing was written, so the File column says so in the clear: an absent file is not a value the seal hides.
      expect(collected.summary[0]).toContain("| private repository #1 | remote | :x: failed | - |");
      expect(collected.summary[0]).toContain(
        "| labels | :x: failed | hidden (private repository) |",
      );
      const publicText = [
        ...collected.lines.map((entry) => entry.line),
        ...collected.summary,
        ...Object.values(collected.outputs),
      ].join("\n");
      expect(publicText).not.toContain("/repos/o/p/labels");
      expect(publicText).not.toContain("o/p.yml");
    }));

  test("a name that would leave the directory fails its target alone; the rest of the fleet is written", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const api = new MockApi({ ...labelsRoute("o/a", [BUG]) });
      const cfg = dirCfg(dir, { reposInput: "../escape,o/a", privateRepos: "show" });
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(1);
      expect(existsSync(join(dir, "escape.yml"))).toBe(false);
      expect(existsSync(join(cfg.snapshotDir, "o", "a.yml"))).toBe(true);
      expect(collected.lines[1]).toEqual({
        level: "error",
        line: `../escape: the repository name "../escape" is not a GitHub owner/name (a "." or ".." segment), so it has no file under ${cfg.snapshotDir}`,
      });
      expect(collected.outputs).toEqual({
        result: "failed",
        "skipped-sections": "",
        "repos-result": JSON.stringify({
          "../escape": { result: "failed", source: "remote", "skipped-sections": [] },
          "o/a": { result: "snapshot", source: "remote", "skipped-sections": [] },
        }),
      });
    }));

  test("a fleet whose every target fails writes nothing and the summary says so", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      // No labels route: the read answers 404, the denial that fails the target under the fail policy.
      const api = new MockApi({});
      const cfg = dirCfg(dir, { reposInput: "o/a", privateRepos: "show" });
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(1);
      expect(existsSync(cfg.snapshotDir)).toBe(false);
      expect(collected.outputs).toEqual({
        "skipped-sections": "",
        result: "failed",
        "repos-result": JSON.stringify({
          "o/a": { result: "failed", source: "remote", "skipped-sections": [] },
        }),
      });
      // The whole rendering; only the detail cell, the engine's denial text, is matched by its head.
      expect(collected.summary[0]?.split("\n")).toEqual([
        "## github-settings-as-code (snapshot, 1 repository)",
        "",
        `No snapshot was written under ${cfg.snapshotDir}.`,
        "",
        TAKEN_LINE,
        "",
        "| Repository | Source | Result | File |",
        "|---|---|---|---|",
        "| o/a | remote | :x: failed | - |",
        "",
        "### o/a (failed)",
        "",
        "the snapshot failed, so no file was written",
        "",
        "| Section | Status | Detail |",
        "|---|---|---|",
        expect.stringMatching(
          /^\| labels \| :x: failed \| the token was denied GET \/repos\/o\/a\/labels/,
        ),
      ]);
    }));

  test("a fleet that resolves to no targets is fatal before any file is written", () =>
    withTempDir("snapshot-flow-", async (dir) => {
      const empty = join(dir, "repos");
      mkdirSync(empty);
      const api = new MockApi({});
      const cfg = dirCfg(dir, { reposInput: "", reposDir: empty });
      const collected = collectingIo();
      expect(await run(api, cfg, collected.io)).toBe(1);
      expect(api.calls).toEqual([]);
      expect(existsSync(join(dir, "snapshots"))).toBe(false);
      expect(collected.outputs).toEqual({
        result: "failed",
        "skipped-sections": "",
        "repos-result": "{}",
      });
      expect(collected.lines[0]).toEqual({
        level: "error",
        line: expect.stringMatching(
          /^multi-repo mode found no targets: repos-dir yielded no settings files/,
        ),
      });
    }));
});
