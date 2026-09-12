/**
 * The mode: snapshot flow over a routed client: the file form writes one
 * document and reports through the outputs and the summary, the dir form
 * writes one file per resolved target under the repos-dir layout, a redacted
 * target's values reach the file and nothing else, and every failure class
 * (denial, unwritable path, a name that would leave the directory, no
 * targets) ends as the documented result.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseRepoSlug } from "../../src/discovery/targets.js";
import { SectionSelection } from "../../src/engine/section-selection.js";
import { failRun } from "../../src/flows/deliver.js";
import {
  concludeSnapshot,
  runSnapshot,
  SNAPSHOT_SCHEMA_URL,
  type SnapshotConfig,
} from "../../src/flows/snapshot.js";
import { collectingIo, type Io } from "../../src/io.js";
import type { SectionKey } from "../../src/schema.js";
import { MockApi } from "../mock-api.js";

const repo = parseRepoSlug("o/r")._unsafeUnwrap();

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

/** An ISO-8601 UTC instant, the form the header dates the snapshot in. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Whether `written` opens with the snapshot header for `slug`: the schema pin
 * compared as a whole string (never as a pattern, so a look-alike host cannot
 * pass), then the dated repository line.
 */
export function hasSnapshotHeader(written: string, slug: string): boolean {
  const [pin, dated] = written.split("\n");
  if (pin !== `# yaml-language-server: $schema=${SNAPSHOT_SCHEMA_URL}`) {
    return false;
  }
  const prefix = `# Snapshot of ${slug} taken `;
  return dated?.startsWith(prefix) === true && ISO_INSTANT.test(dated.slice(prefix.length));
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "snapshot-flow-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type FileConfig = Extract<SnapshotConfig, { form: "file" }>;
type DirConfig = Extract<SnapshotConfig, { form: "dir" }>;

const fileCfg = (overrides: Partial<FileConfig> = {}): FileConfig =>
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

const dirCfg = (overrides: Partial<DirConfig> = {}): DirConfig =>
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

describe("hasSnapshotHeader", () => {
  const header = (url: string, slug = "o/r", instant = "2026-09-12T01:00:06.503Z") =>
    `# yaml-language-server: $schema=${url}\n# Snapshot of ${slug} taken ${instant}\nlabels: []\n`;

  test("accepts the exact pin and a dated line; rejects a look-alike host, another slug, and a non-instant", () => {
    expect(hasSnapshotHeader(header(SNAPSHOT_SCHEMA_URL), "o/r")).toBe(true);
    // The URL's dots are literal: a host with one dot swapped for another character is not the pin.
    expect(
      hasSnapshotHeader(
        header(SNAPSHOT_SCHEMA_URL.replace("githubusercontent.com", "githubusercontentXcom")),
        "o/r",
      ),
    ).toBe(false);
    expect(hasSnapshotHeader(header(SNAPSHOT_SCHEMA_URL, "o/other"), "o/r")).toBe(false);
    expect(hasSnapshotHeader(header(SNAPSHOT_SCHEMA_URL, "o/r", "yesterday"), "o/r")).toBe(false);
  });
});

describe("runSnapshot, file form", () => {
  test("writes the document under its header and reports through the outputs, the log, and the summary", async () => {
    const api = new MockApi(labelsRoute("o/r", [BUG, DOCS]));
    const cfg = fileCfg();
    const collected = collectingIo();
    expect(await run(api, cfg, collected.io)).toBe(0);
    const written = readFileSync(cfg.snapshotFile, "utf8");
    expect(hasSnapshotHeader(written, "o/r")).toBe(true);
    expect(parseYaml(written)).toEqual(doc(BUG, DOCS));
    expect(api.mutations()).toEqual([]);
    expect(collected.outputs).toEqual({ "skipped-sections": "", result: "snapshot" });
    expect(collected.lines).toEqual([
      { line: `snapshot written to ${cfg.snapshotFile}` },
      { line: "result: snapshot" },
    ]);
    expect(collected.summary).toEqual([
      [
        "## github-settings-as-code (snapshot)",
        "",
        `:white_check_mark: snapshot - written to ${cfg.snapshotFile}`,
        "",
        "| Section | Status | Detail |",
        "|---|---|---|",
        "| labels | :white_check_mark: snapshot | - |",
      ].join("\n"),
    ]);
  });

  test("a denied section is skipped under warn: partial, the file omits it, the header and the outputs say so", async () => {
    // No variables route: the read answers 404, the fine-grained denial.
    const api = new MockApi(labelsRoute("o/r", [BUG]));
    const cfg = fileCfg({
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
      "skipped-sections": "actions_variables",
      result: "partial",
    });
    expect(collected.lines.map((entry) => `${entry.level ?? "log"}: ${entry.line}`)).toEqual([
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
  });

  test("a denied section under fail fails the run and writes no file", async () => {
    const api = new MockApi(labelsRoute("o/r", [BUG]));
    const cfg = fileCfg({ sections: only("labels", "actions_variables") });
    const collected = collectingIo();
    expect(await run(api, cfg, collected.io)).toBe(1);
    expect(existsSync(cfg.snapshotFile)).toBe(false);
    expect(collected.outputs).toEqual({ "skipped-sections": "", result: "failed" });
    expect(collected.lines).toEqual([
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
  });

  test("an unwritable snapshot-file fails the run naming the input", async () => {
    const api = new MockApi(labelsRoute("o/r", [BUG]));
    writeFileSync(join(dir, "blocker"), "");
    const cfg = fileCfg({ snapshotFile: join(dir, "blocker", "snapshot.yml") });
    const collected = collectingIo();
    expect(await run(api, cfg, collected.io)).toBe(1);
    expect(collected.outputs.result).toBe("failed");
    const [first] = collected.lines;
    expect(first?.level).toBe("error");
    // The path is compared as text, never as a pattern; the OS error code sits between.
    expect(first?.line.startsWith(`cannot write the snapshot to ${cfg.snapshotFile}: `)).toBe(true);
    expect(first?.line).toMatch(/E(EXIST|NOTDIR)/);
    expect(
      first?.line.endsWith('. Check that the "snapshot-file" input names a writable path'),
    ).toBe(true);
  });
});

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
    line: `cannot write the snapshot to ${path}: Error: ${os}. Check that the "${input}" input names a writable path`,
  });

  test("a staging write that fails leaves the previous snapshot intact and reports the write's error", async () => {
    const api = new MockApi(labelsRoute("o/r", [BUG]));
    const cfg = fileCfg();
    const staging = `${cfg.snapshotFile}.tmp`;
    mkdirSync(dirname(cfg.snapshotFile), { recursive: true });
    writeFileSync(cfg.snapshotFile, "labels: []\n");
    // A directory at the staging path fails the write before the rename; the run must not remove it either.
    mkdirSync(staging);
    const collected = collectingIo();
    expect(await run(api, cfg, collected.io)).toBe(1);
    expect(collected.outputs.result).toBe("failed");
    expect(collected.lines[0]).toEqual(
      unwritable(
        cfg.snapshotFile,
        "snapshot-file",
        `EISDIR: illegal operation on a directory, open '${staging}'`,
      ),
    );
    expect(readFileSync(cfg.snapshotFile, "utf8")).toBe("labels: []\n");
    rmSync(staging, { recursive: true });
    expect(await run(api, cfg, collectingIo().io)).toBe(0);
    expect(parseYaml(readFileSync(cfg.snapshotFile, "utf8"))).toEqual(doc(BUG));
    expect(existsSync(staging)).toBe(false);
  });

  test("a rename that fails removes the staging file, fails only that target, and leaves the destination as it was", async () => {
    const api = new MockApi({
      "GET /repos/o/a": { data: { private: false } },
      "GET /repos/o/b": { data: { private: false } },
      ...labelsRoute("o/a", [BUG]),
      ...labelsRoute("o/b", [DOCS]),
    });
    const cfg = dirCfg();
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
        "o/a": { result: "failed", source: "remote", skippedSections: [] },
        "o/b": { result: "snapshot", source: "remote", skippedSections: [] },
      }),
    });
    const { level, line } = unwritable(
      fileA,
      "snapshot-dir",
      `EISDIR: illegal operation on a directory, rename '${fileA}.tmp' -> '${fileA}'`,
    );
    expect(collected.lines[0]).toEqual({ level, line: `o/a: ${line}` });
    expect(existsSync(`${fileA}.tmp`)).toBe(false);
    expect(readFileSync(join(fileA, "keep"), "utf8")).toBe("authored\n");
    expect(parseYaml(readFileSync(fileB, "utf8"))).toEqual(doc(DOCS));
    expect(existsSync(`${fileB}.tmp`)).toBe(false);
  });
});

describe("runSnapshot refuses a destination that would overwrite an authored file", () => {
  test.each([
    [
      "snapshot-file naming the settings file apply reads",
      () => fileCfg({ snapshotFile: "./.github/settings.yml" }),
      'the "snapshot-file" input "./.github/settings.yml" is the settings file apply and check read (.github/settings.yml): the snapshot would overwrite the document you author. Write it to another path and copy it over deliberately',
    ],
    [
      "snapshot-dir equal to the repos-dir",
      () => dirCfg({ snapshotDir: "./repos", reposDir: "repos" }),
      disjointRefusal("./repos", "repos"),
    ],
    [
      "snapshot-dir above the repos-dir, where a bare <name>.yml would be overwritten",
      () => dirCfg({ snapshotDir: "central", reposDir: "central/acme" }),
      disjointRefusal("central", "central/acme"),
    ],
    [
      "snapshot-dir below the repos-dir under a name starting with two dots, which is still below it",
      () => dirCfg({ snapshotDir: "central/..snapshots", reposDir: "central" }),
      disjointRefusal("central/..snapshots", "central"),
    ],
    [
      "snapshot-dir below the repos-dir, where the next run would read the snapshots as central files",
      () => dirCfg({ snapshotDir: "central/snapshots", reposDir: "central" }),
      disjointRefusal("central/snapshots", "central"),
    ],
  ])("%s fails before any API call or write", async (_case, cfg, message) => {
    const api = new MockApi({});
    const collected = collectingIo();
    expect(await run(api, cfg(), collected.io)).toBe(1);
    expect(api.calls).toEqual([]);
    expect(collected.outputs).toEqual({ "skipped-sections": "", result: "failed" });
    expect(collected.lines).toEqual([
      { level: "error", line: message },
      { line: "result: failed" },
    ]);
  });
});

describe("runSnapshot, dir form", () => {
  test("writes one <owner>/<name>.yml per resolved target and publishes the per-target rollup", async () => {
    const api = new MockApi({
      "GET /repos/o/a": { data: { private: false } },
      "GET /repos/o/b": { data: { private: false } },
      ...labelsRoute("o/a", [BUG]),
      ...labelsRoute("o/b", [DOCS]),
    });
    const cfg = dirCfg();
    const collected = collectingIo();
    expect(await run(api, cfg, collected.io)).toBe(0);
    const fileA = join(cfg.snapshotDir, "o", "a.yml");
    const fileB = join(cfg.snapshotDir, "o", "b.yml");
    expect(hasSnapshotHeader(readFileSync(fileA, "utf8"), "o/a")).toBe(true);
    expect(parseYaml(readFileSync(fileA, "utf8"))).toEqual(doc(BUG));
    expect(parseYaml(readFileSync(fileB, "utf8"))).toEqual(doc(DOCS));
    expect(api.mutations()).toEqual([]);
    expect(collected.outputs).toEqual({
      "skipped-sections": "",
      result: "snapshot",
      "repos-result": JSON.stringify({
        "o/a": { result: "snapshot", source: "remote", skippedSections: [] },
        "o/b": { result: "snapshot", source: "remote", skippedSections: [] },
      }),
    });
    expect(collected.lines).toEqual([
      { line: `o/a: snapshot written to ${fileA}` },
      { line: `o/b: snapshot written to ${fileB}` },
      { line: "result: snapshot" },
    ]);
    expect(collected.summary).toEqual([
      [
        "## github-settings-as-code (snapshot, 2 repositories)",
        "",
        `Snapshots written under ${cfg.snapshotDir}.`,
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
      ].join("\n"),
    ]);
  });

  test("a redacted target's values reach its file and nothing else: the slug is masked, the public view shows the placeholder", async () => {
    const api = new MockApi({
      "GET /repos/o/a": { data: { private: false } },
      "GET /repos/o/p": { data: { private: true, visibility: "private" } },
      ...labelsRoute("o/a", [BUG]),
      ...labelsRoute("o/p", [{ name: "secret-project", color: "000000", description: "hush" }]),
    });
    const cfg = dirCfg({ reposInput: "o/a,o/p" });
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
    expect(collected.outputs["repos-result"]).toBe(
      JSON.stringify({
        "o/a": { result: "snapshot", source: "remote", skippedSections: [] },
        "private repository #1": { result: "snapshot", source: "remote", skippedSections: [] },
      }),
    );
    expect(collected.summary[0]).toContain(
      "| private repository #1 | remote | :white_check_mark: snapshot | hidden (private repository) |",
    );
    expect(collected.summary[0]).toContain(
      "### private repository #1 (snapshot)\n\ndetails hidden: the repository is private or internal.",
    );
    expect(collected.summary[0]).toContain(
      "| labels | :white_check_mark: snapshot | hidden (private repository) |",
    );
  });

  test("a name that would leave the directory fails its target alone; the rest of the fleet is written", async () => {
    const api = new MockApi({ ...labelsRoute("o/a", [BUG]) });
    const cfg = dirCfg({ reposInput: "../escape,o/a", privateRepos: "show" });
    const collected = collectingIo();
    expect(await run(api, cfg, collected.io)).toBe(1);
    expect(existsSync(join(dir, "escape.yml"))).toBe(false);
    expect(existsSync(join(cfg.snapshotDir, "o", "a.yml"))).toBe(true);
    expect(collected.outputs.result).toBe("failed");
    expect(collected.lines[0]).toEqual({
      level: "error",
      line: `../escape: the repository name "../escape" is not a GitHub owner/name (a "." or ".." segment), so it has no file under ${cfg.snapshotDir}`,
    });
    expect(JSON.parse(collected.outputs["repos-result"] ?? "")).toEqual({
      "../escape": { result: "failed", source: "remote", skippedSections: [] },
      "o/a": { result: "snapshot", source: "remote", skippedSections: [] },
    });
  });

  test("a fleet that resolves to no targets is fatal before any file is written", async () => {
    const empty = join(dir, "repos");
    mkdirSync(empty);
    const api = new MockApi({});
    const cfg = dirCfg({ reposInput: "", reposDir: empty });
    const collected = collectingIo();
    expect(await run(api, cfg, collected.io)).toBe(1);
    expect(api.calls).toEqual([]);
    expect(existsSync(join(dir, "snapshots"))).toBe(false);
    expect(collected.outputs).toEqual({ "skipped-sections": "", result: "failed" });
    expect(collected.lines[0]).toEqual({
      level: "error",
      line: expect.stringMatching(
        /^multi-repo mode found no targets: repos-dir yielded no settings files/,
      ),
    });
  });
});
