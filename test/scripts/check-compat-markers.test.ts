import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkCompatMarkers } from "../../.github/scripts/check-compat-markers.js";

const SCRIPT = join(import.meta.dir, "..", "..", ".github", "scripts", "check-compat-markers.ts");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A throwaway git repository under os.tmpdir() holding `files`, its package.json at `version`. Its own .gitignore
 * is the only excludes source: the machine's global excludes file would otherwise hide fixture files. */
function repo(version: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "compat-markers-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "core.excludesFile", "/dev/null"], { cwd: root });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fixture", version })}\n`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const SYNTAX = "COMPAT(v<major>): <what stays working and what to delete>";

function malformed(where: string, found: string): string {
  return `${where}: malformed marker ${JSON.stringify(found)}; write ${SYNTAX}`;
}

function due(where: string, major: number, dueLine: string): string {
  return `${where}: COMPAT(v${major}) is due: v${major} is at or below ${dueLine}; delete the compat path or re-justify it with a higher major`;
}

describe("checkCompatMarkers", () => {
  test("lists well-formed markers by removal major across file types and passes under the due line", () => {
    const cwd = repo("2.0.0", {
      "src/inputs.ts":
        'const dir = input("repos_dir"); // COMPAT(v3): accept the pre-2.1 "repos_dir" input name; delete this branch and the alias\n',
      "src/cache.ts":
        "/* COMPAT(v4): read the v3 cache layout; delete the reader */ // COMPAT(v4): and the v3 key format; delete the parser\nexport {};\n",
      "src/config.ts":
        '// COMPAT(v3): config.json\'s retired "legacy" key still loads; delete this fallback\n',
      "config.json": '{"legacy": true}\n',
      ".github/workflows/publish.yml":
        "name: publish\n# COMPAT(v3): tolerate the old asset name; delete this step\n",
      "docs/anchors.md":
        "The marker is `COMPAT(vN): <what stays working and what to delete>`, a `COMPAT(vN)` comment.\n\nCOMPAT(v5): keep the old anchor ids; delete the redirect table\n<!-- COMPAT(v5): the old heading slugs still resolve; delete the redirect list -->\n",
    });
    expect(checkCompatMarkers({ cwd })).toEqual({
      code: 0,
      stdout: [
        "COMPAT markers by removal major (package.json 2.0.0):",
        "  v3",
        "    .github/workflows/publish.yml:2  tolerate the old asset name; delete this step",
        '    src/config.ts:1  config.json\'s retired "legacy" key still loads; delete this fallback',
        '    src/inputs.ts:1  accept the pre-2.1 "repos_dir" input name; delete this branch and the alias',
        "  v4",
        "    src/cache.ts:1  read the v3 cache layout; delete the reader",
        "    src/cache.ts:1  and the v3 key format; delete the parser",
        "  v5",
        "    docs/anchors.md:3  keep the old anchor ids; delete the redirect table",
        "    docs/anchors.md:4  the old heading slugs still resolve; delete the redirect list",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("names every malformed occurrence by file and line, and still lists the well-formed ones", () => {
    const cwd = repo("2.0.0", {
      "src/m.ts": [
        "// COMPAT(v3) accept the old key",
        "// COMPAT(3): drop the v prefix",
        "// COMPAT(v3):",
        "// COMPAT(vN): the placeholder outside Markdown",
        "// COMPAT(v03): a leading zero",
        "/* COMPAT(v3): */",
        "const legacy = /* COMPAT(v3): */ true;",
        "// COMPAT(v3): fine; delete it",
        '// COMPAT(v3): the "#" alias still parses; delete support for #',
        "// COMPAT(v3): keep the src/**/ glob; delete the legacy matcher */",
        "",
      ].join("\n"),
      "notes.md":
        "A `COMPAT(vN)` marker, and one gone wrong: COMPAT(v3)\n<!-- COMPAT(v3): -->\n<!-- COMPAT(vN): keep the old anchor; delete the redirect -->\n",
    });
    expect(checkCompatMarkers({ cwd })).toEqual({
      code: 1,
      stdout: [
        "COMPAT markers by removal major (package.json 2.0.0):",
        "  v3",
        "    src/m.ts:8  fine; delete it",
        '    src/m.ts:9  the "#" alias still parses; delete support for #',
        "    src/m.ts:10  keep the src/**/ glob; delete the legacy matcher */",
        "",
      ].join("\n"),
      stderr: [
        malformed("notes.md:1", "COMPAT(v3)"),
        malformed("notes.md:2", "COMPAT(v3): -->"),
        malformed("notes.md:3", "COMPAT(vN): keep the old anchor; delete the redirect -->"),
        malformed("src/m.ts:1", "COMPAT(v3) accept the old key"),
        malformed("src/m.ts:2", "COMPAT(3): drop the v prefix"),
        malformed("src/m.ts:3", "COMPAT(v3):"),
        malformed("src/m.ts:4", "COMPAT(vN): the placeholder outside Markdown"),
        malformed("src/m.ts:5", "COMPAT(v03): a leading zero"),
        malformed("src/m.ts:6", "COMPAT(v3): */"),
        malformed("src/m.ts:7", "COMPAT(v3): */ true;"),
        "",
      ].join("\n"),
    });
  });

  // The due line is package.json's major, or the major a release PR cuts; a marker at or below it fails.
  test.each<[string, string, number, number | undefined, string | undefined]>([
    ["a marker above the current major passes", "2.0.0", 3, undefined, undefined],
    ["at the current major", "2.0.0", 2, undefined, "the current major v2 (package.json 2.0.0)"],
    ["below the current major", "2.0.0", 1, undefined, "the current major v2 (package.json 2.0.0)"],
    ["a v0 marker under 0.x", "0.4.0", 0, undefined, "the current major v0 (package.json 0.4.0)"],
    [
      "the release PR's own tree, bumped to the major",
      "3.0.0",
      3,
      undefined,
      "the current major v3 (package.json 3.0.0)",
    ],
    ["a release targeting the marker's major", "2.0.0", 3, 3, "the release target v3"],
    ["a release targeting a major above the marker's", "2.0.0", 2, 3, "the release target v3"],
    ["a marker beyond the release target passes", "2.0.0", 4, 3, undefined],
    ["a minor release targets the current major, the default gate", "2.0.0", 3, 2, undefined],
  ])("%s", (_, version, major, targetMajor, dueLine) => {
    const cwd = repo(version, {
      "src/x.ts": `// COMPAT(v${major}): the old shape still parses; delete the branch\n`,
    });
    const context =
      targetMajor === undefined
        ? `package.json ${version}`
        : `package.json ${version}, release target v${targetMajor}`;
    expect(checkCompatMarkers({ cwd, targetMajor })).toEqual({
      code: dueLine === undefined ? 0 : 1,
      stdout: [
        `COMPAT markers by removal major (${context}):`,
        `  v${major}`,
        "    src/x.ts:1  the old shape still parses; delete the branch",
        "",
      ].join("\n"),
      stderr: dueLine === undefined ? "" : `${due("src/x.ts:1", major, dueLine)}\n`,
    });
  });

  test("skips built output, dependencies, the fetched spec, the changelog, ignored files, symlinks, deleted tracked files, and its own two files", () => {
    const marker = "// COMPAT(v3): kept; delete it\n";
    const cwd = repo("2.0.0", {
      ".gitignore": "scratch/\n",
      "lib/index.js": marker,
      "node_modules/dep/index.js": marker,
      "test/e2e/openapi/github-openapi.trimmed.json": marker,
      "CHANGELOG.md": "* remove the COMPAT(v3) legacy reader (#12)\n",
      "scratch/out.ts": marker,
      "gone.ts": marker,
      ".github/scripts/check-compat-markers.ts": "// COMPAT(v3) the syntax, spelled to define it\n",
      "test/scripts/check-compat-markers.test.ts": "// COMPAT(3): a fixture text\n",
      ".github/scripts/check-compat-markers.tsx": marker,
      "AGENTS.md":
        "Rules.\n\nCOMPAT(v3): the old rule wording still applies; delete this paragraph\n",
      "src/real.ts": marker,
    });
    symlinkSync("AGENTS.md", join(cwd, "CLAUDE.md"));
    execFileSync("git", ["add", "gone.ts"], { cwd });
    rmSync(join(cwd, "gone.ts"));
    expect(checkCompatMarkers({ cwd })).toEqual({
      code: 0,
      stdout: [
        "COMPAT markers by removal major (package.json 2.0.0):",
        "  v3",
        "    .github/scripts/check-compat-markers.tsx:1  kept; delete it",
        "    AGENTS.md:3  the old rule wording still applies; delete this paragraph",
        "    src/real.ts:1  kept; delete it",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a tree without markers says so", () => {
    const cwd = repo("2.0.0", { "src/x.ts": "export {};\n" });
    expect(checkCompatMarkers({ cwd })).toEqual({
      code: 0,
      stdout: "no COMPAT markers (package.json 2.0.0)\n",
      stderr: "",
    });
  });

  test.each<[string, string, number | undefined, string]>([
    [
      "a release target below the current major",
      "2.0.0",
      1,
      "--target-major 1 is below package.json's major 2 (2.0.0); a release never targets an older major.",
    ],
    [
      "a package.json version that is not X.Y.Z",
      "2.0",
      undefined,
      'package.json\'s version "2.0" is not X.Y.Z; refusing to derive the due line from it.',
    ],
  ])("refuses %s", (_, version, targetMajor, message) => {
    const cwd = repo(version, {});
    expect(() => checkCompatMarkers({ cwd, targetMajor })).toThrow(message);
  });

  test("a listed path that cannot be inspected for any reason but absence stops the scan", () => {
    const cwd = repo("2.0.0", { "dir/file.ts": "export {};\n" });
    execFileSync("git", ["add", "dir/file.ts"], { cwd });
    // The tracked path's parent is now a regular file: lstat fails with ENOTDIR, not ENOENT.
    rmSync(join(cwd, "dir"), { recursive: true });
    writeFileSync(join(cwd, "dir"), "");
    expect(() => checkCompatMarkers({ cwd })).toThrow(/ENOTDIR/);
  });
});

describe("the CLI", () => {
  const DUE = "// COMPAT(v2): the old shape still parses; delete the branch\n";
  const table = (context: string) =>
    [
      `COMPAT markers by removal major (${context}):`,
      "  v2",
      "    src/x.ts:1  the old shape still parses; delete the branch",
      "",
    ].join("\n");

  test.each<[string, string, string[], { status: number; stdout: string; stderr: string }]>([
    [
      "a due marker fails with the table on stdout and the failure on stderr",
      "2.0.0",
      [],
      {
        status: 1,
        stdout: table("package.json 2.0.0"),
        stderr: `${due("src/x.ts:1", 2, "the current major v2 (package.json 2.0.0)")}\n`,
      },
    ],
    [
      "a marker above the release target passes",
      "1.0.0",
      ["--target-major", "1"],
      { status: 0, stdout: table("package.json 1.0.0, release target v1"), stderr: "" },
    ],
    [
      "a malformed flag is a usage error before any scan",
      "2.0.0",
      ["--target-major", "x"],
      {
        status: 1,
        stdout: "",
        stderr:
          'check-compat-markers: usage: check-compat-markers.ts [--target-major <major>]; got ["--target-major","x"]\n',
      },
    ],
    [
      "a release target below the current major is refused",
      "2.0.0",
      ["--target-major", "1"],
      {
        status: 1,
        stdout: "",
        stderr:
          "check-compat-markers: --target-major 1 is below package.json's major 2 (2.0.0); a release never targets an older major.\n",
      },
    ],
  ])("%s", (_, version, argv, expected) => {
    const cwd = repo(version, { "src/x.ts": DUE });
    const run = spawnSync("bun", [SCRIPT, ...argv], { cwd, encoding: "utf8" });
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual(expected);
  });
});
