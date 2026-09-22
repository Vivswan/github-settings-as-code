import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  GENERATED_OUTPUTS,
  generatedPaths,
  generatorEntryPoint,
  generatorScripts,
} from "../../.github/scripts/generated.js";
import {
  hasGeneratedRegion,
  markerSyntaxFor,
  SYNTAX_BY_EXTENSION,
} from "../../.github/scripts/lib/generated-regions.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

/** Only a file type with a marker syntax carries a region; a marker string anywhere else is test or script text. */
const regionFile = (path: string): boolean => extname(path) in SYNTAX_BY_EXTENSION;
/** action-docs's own region markers, the one grammar lib/generated-regions.ts does not read. */
const ACTION_DOCS_MARKER = /<!-- action-docs-(?:inputs|outputs) source="/;
const scripts = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;
/** The outputs the marker scan cannot see: whole generated files. */
const WHOLE_FILES = ["src/upstream-gaps/index.ts"];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((path) => path !== "");

describe("the generated-output table", () => {
  test("is exactly the tree's generated files: every tracked marker-carrying page plus the whole files, once each", () => {
    const carrying = tracked.filter((path) => {
      if (!regionFile(path)) return false;
      const text = readFileSync(join(ROOT, path), "utf8");
      return hasGeneratedRegion(text, markerSyntaxFor(path)) || ACTION_DOCS_MARKER.test(text);
    });
    const paths = generatedPaths();
    expect([...paths].sort()).toEqual([...carrying, ...WHOLE_FILES].sort());
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      GENERATED_OUTPUTS.filter((output) => output.kind === "file")
        .map((output) => output.path)
        .sort(),
    ).toEqual(WHOLE_FILES);
  });

  test("every generator is a package.json script over tracked files, and bun run build runs them in table order", () => {
    // build:check runs the generators through their package.json scripts, so a script renamed or dropped there
    // fails every build:check run; build must regenerate the same outputs, in the same order, so a fresh clone
    // builds what CI verifies.
    const generators = generatorScripts();
    for (const generator of generators) {
      const file = generatorEntryPoint(scripts[generator] ?? "");
      expect(
        file,
        `${generator} is a package.json script of the shape bun <file>.ts`,
      ).not.toBeNull();
      expect(tracked, `${generator} runs ${file}`).toContain(file ?? "");
    }
    const built = [...(scripts.build ?? "").matchAll(/bun run (\S+)/g)].map(([, name]) => name);
    expect(built.filter((name) => generators.includes(name ?? ""))).toEqual(generators);
    // The bundle and the library compile src/upstream-gaps/index.ts, so a gap file added by hand must reach the
    // index before either builds, or one bun run build ships a bundle without it.
    for (const consumer of ["build:bundle", "build:lib"]) {
      expect(built.indexOf("build:gaps-index"), `build:gaps-index before ${consumer}`).toBeLessThan(
        built.indexOf(consumer),
      );
    }
  });

  test("the scan reads the shared marker grammar: an inline HTML marker counts, a marker-shaped scalar does not", () => {
    // A page whose only marker sits mid-line (inputs.md's outputs-list is the tree's inline case) would slip a line-anchored scan.
    expect(
      hasGeneratedRegion(
        "- `result`: <!-- BEGIN GENERATED: a (h) -->x<!-- END GENERATED: a -->",
        "html",
      ),
    ).toBe(true);
    expect(hasGeneratedRegion("the words BEGIN GENERATED: a outside a comment\n", "html")).toBe(
      false,
    );
    expect(
      hasGeneratedRegion("inputs:\n  # BEGIN GENERATED: a\n  # END GENERATED: a\n", "yaml"),
    ).toBe(true);
    expect(hasGeneratedRegion('d: "one\n  # BEGIN GENERATED: a\n  two"\n', "yaml")).toBe(false);
  });
});

describe("the build:check runner", () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  /** The runner's exit code and everything it printed on either stream. */
  function runner(cwd: string): { status: number; printed: string } {
    const run = Bun.spawnSync([process.execPath, ".github/scripts/generated.ts"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { status: run.exitCode, printed: run.stdout.toString() + run.stderr.toString() };
  }

  test(
    "a clean clone passes; a staged stale byte in a page, in action.yml, and in a whole file fails naming each",
    () =>
      withTempDir("build-check-", (dir) => {
        // HEAD's tree with its own index, sharing the object store and node_modules; the runner, the generators,
        // and the script table they run through are copied from the working tree, so the code under test is the
        // code being edited.
        git(ROOT, "clone", "--quiet", "--shared", ROOT, dir);
        symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
        cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
        cpSync(join(ROOT, ".github", "scripts"), join(dir, ".github", "scripts"), {
          recursive: true,
        });
        const untouched = [
          ".",
          ":(exclude)node_modules",
          ":(exclude).github/scripts",
          ":(exclude)package.json",
        ];

        const clean = runner(dir);
        expect(clean.status).toBe(0);
        expect(clean.printed).not.toContain("drifted");
        expect(git(dir, "status", "--porcelain", "--", ...untouched)).toBe("");

        // A stale byte each region generator repairs (the region shapes hold), and one in a wholesale file.
        const table = join(dir, "docs/reference/sections.md");
        const page = readFileSync(table, "utf8");
        expect(page).toContain("| `labels` |");
        writeFileSync(table, page.replace("| `labels` |", "| `labelz` |"));
        const inputs = join(dir, "docs/reference/inputs.md");
        const inputsPage = readFileSync(inputs, "utf8");
        expect(inputsPage).toContain("| `token` |");
        writeFileSync(inputs, inputsPage.replace("| `token` |", "| `tokem` |"));
        const manifest = join(dir, "action.yml");
        const yml = readFileSync(manifest, "utf8");
        expect(yml).toContain('    default: ""\n');
        writeFileSync(manifest, yml.replace('    default: ""\n', '    default: "stale"\n'));
        const index = join(dir, "src/upstream-gaps/index.ts");
        writeFileSync(index, `${readFileSync(index, "utf8")}\n`);
        git(
          dir,
          "add",
          "docs/reference/sections.md",
          "docs/reference/inputs.md",
          "action.yml",
          "src/upstream-gaps/index.ts",
        );

        const stale = runner(dir);
        expect(stale.status).toBe(1);
        // git's own --stat lists the four staged stale paths.
        expect(stale.printed).toContain("docs/reference/sections.md");
        expect(stale.printed).toContain("docs/reference/inputs.md");
        expect(stale.printed).toContain("action.yml");
        expect(stale.printed).toContain("src/upstream-gaps/index.ts");
        // The generators repaired the working tree; only the staged stale copies differ.
        expect(
          git(dir, "diff", "--name-only", "--", ...untouched)
            .trim()
            .split("\n")
            .sort(),
        ).toEqual([
          "action.yml",
          "docs/reference/inputs.md",
          "docs/reference/sections.md",
          "src/upstream-gaps/index.ts",
        ]);
      }),
    120_000,
  );
});
