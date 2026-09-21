import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { GENERATED_OUTPUTS, generatedPaths } from "../../.github/scripts/generated.js";
import {
  hasGeneratedRegion,
  markerSyntaxFor,
  SYNTAX_BY_EXTENSION,
} from "../../.github/scripts/lib/generated-regions.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

/** Only a file type with a marker syntax carries a region; a marker string anywhere else is test or script text. */
const regionFile = (path: string): boolean => extname(path) in SYNTAX_BY_EXTENSION;
/** The outputs the marker scan cannot see: whole generated files. */
const WHOLE_FILES = [
  "lib/settings.schema.json",
  "src/sections/webhooks/events.ts",
  "src/upstream-gaps/index.ts",
];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((path) => path !== "");

describe("the generated-output table", () => {
  test("is exactly the tree's generated files: every tracked marker-carrying page plus the whole files, once each", () => {
    const carrying = tracked.filter(
      (path) =>
        regionFile(path) &&
        hasGeneratedRegion(readFileSync(join(ROOT, path), "utf8"), markerSyntaxFor(path)),
    );
    const paths = generatedPaths();
    expect([...paths].sort()).toEqual([...carrying, ...WHOLE_FILES].sort());
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      GENERATED_OUTPUTS.filter((output) => output.kind === "file")
        .map((output) => output.path)
        .sort(),
    ).toEqual(WHOLE_FILES);
    for (const generator of new Set(GENERATED_OUTPUTS.map((output) => output.generator))) {
      expect(tracked, generator).toContain(generator);
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
    "a clean clone passes; a staged stale byte in a region file and in a whole file fails naming both",
    () =>
      withTempDir("build-check-", (dir) => {
        // HEAD's tree with its own index, sharing the object store and node_modules; the runner and the
        // generators are copied from the working tree, so the code under test is the code being edited.
        git(ROOT, "clone", "--quiet", "--shared", ROOT, dir);
        symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
        // The docs generator reads the fetched, gitignored OpenAPI spec, which the clone lacks; it borrows the tree's.
        const spec = join("test", "e2e", "openapi", "github-openapi.trimmed.json");
        symlinkSync(join(ROOT, spec), join(dir, spec));
        cpSync(join(ROOT, ".github", "scripts"), join(dir, ".github", "scripts"), {
          recursive: true,
        });
        const untouched = [".", ":(exclude)node_modules", ":(exclude).github/scripts"];

        const clean = runner(dir);
        expect(clean.status).toBe(0);
        expect(clean.printed).not.toContain("drifted");
        expect(git(dir, "status", "--porcelain", "--", ...untouched)).toBe("");

        // A stale cell the generator repairs (the row shape holds), and a stale byte in a wholesale file.
        const table = join(dir, "docs/reference/sections.md");
        const page = readFileSync(table, "utf8");
        expect(page).toContain("| `labels` |");
        writeFileSync(table, page.replace("| `labels` |", "| `labelz` |"));
        const index = join(dir, "src/upstream-gaps/index.ts");
        writeFileSync(index, `${readFileSync(index, "utf8")}\n`);
        git(dir, "add", "docs/reference/sections.md", "src/upstream-gaps/index.ts");

        const stale = runner(dir);
        expect(stale.status).toBe(1);
        // git's own --stat lists the two staged stale paths.
        expect(stale.printed).toContain("docs/reference/sections.md");
        expect(stale.printed).toContain("src/upstream-gaps/index.ts");
        // The generators repaired the working tree; only the staged stale copies differ.
        expect(
          git(dir, "diff", "--name-only", "--", ...untouched)
            .trim()
            .split("\n")
            .sort(),
        ).toEqual(["docs/reference/sections.md", "src/upstream-gaps/index.ts"]);
      }),
    120_000,
  );
});
