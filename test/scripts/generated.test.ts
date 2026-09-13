import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_OUTPUTS, generatedPaths } from "../../.github/scripts/generated.js";
import {
  hasGeneratedRegion,
  markerSyntaxFor,
} from "../../.github/scripts/lib/generated-regions.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

/** The file types generated-regions.ts has a marker syntax for; a marker string anywhere else is test or script text. */
const REGION_FILE = /\.(?:md|ya?ml)$/;

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((path) => path !== "");

describe("the generated-output table", () => {
  const carrying = tracked.filter(
    (path) =>
      REGION_FILE.test(path) &&
      hasGeneratedRegion(readFileSync(join(ROOT, path), "utf8"), markerSyntaxFor(path)),
  );
  /** The outputs the marker scan cannot see: whole generated files. */
  const WHOLE_FILES = ["lib/settings.schema.json", "src/upstream-gaps/index.ts"];

  test("holds exactly the tracked files that carry a generated-region marker", () => {
    const registered = GENERATED_OUTPUTS.filter((output) => output.kind === "regions").map(
      (output) => output.path,
    );
    expect([...new Set(registered)].sort()).toEqual(carrying.sort());
  });

  test("the scan reads the shared marker grammar: an inline HTML marker counts, a marker-shaped scalar does not", () => {
    // inputs.md's outputs-list marker sits mid-line; a line-anchored scan would drop that page from the pin.
    expect(
      hasGeneratedRegion(
        "- `result`: <!-- BEGIN GENERATED: a (h) -->x<!-- END GENERATED: a -->",
        "html",
      ),
    ).toBe(true);
    expect(
      hasGeneratedRegion("<!-- BEGIN GENERATED: a -->\n<!-- END GENERATED: a -->\n", "html"),
    ).toBe(true);
    expect(hasGeneratedRegion("the words BEGIN GENERATED: a outside a comment\n", "html")).toBe(
      false,
    );
    expect(
      hasGeneratedRegion("inputs:\n  # BEGIN GENERATED: a\n  # END GENERATED: a\n", "yaml"),
    ).toBe(true);
    expect(hasGeneratedRegion('d: "one\n  # BEGIN GENERATED: a\n  two"\n', "yaml")).toBe(false);
  });

  test("names the whole-file outputs the marker scan cannot see, each tracked with one writer", () => {
    const files = GENERATED_OUTPUTS.filter((output) => output.kind === "file");
    expect(files.map((output) => output.path).sort()).toEqual(WHOLE_FILES);
    for (const { path, generator } of files) {
      expect(tracked, path).toContain(path);
      expect(
        GENERATED_OUTPUTS.filter((output) => output.path === path),
        path,
      ).toEqual([{ path, generator, kind: "file" }]);
    }
  });

  test("every generator is a tracked script, and build:check runs this table", () => {
    for (const generator of new Set(GENERATED_OUTPUTS.map((output) => output.generator))) {
      expect(tracked, generator).toContain(generator);
      expect(existsSync(join(ROOT, generator)), generator).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["build:check"]).toBe("bun .github/scripts/generated.ts");
  });

  test("generatedPaths() is exactly the tree's generated files, once each, the schema first", () => {
    const paths = generatedPaths();
    expect([...paths].sort()).toEqual([...carrying, ...WHOLE_FILES].sort());
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths[0]).toBe("lib/settings.schema.json");
    // The one page two generators write into is a single path to diff.
    expect(
      GENERATED_OUTPUTS.filter((output) => output.path === "docs/reference/inputs.md"),
    ).toHaveLength(2);
  });
});

describe("the build:check runner", () => {
  const RUNNER = ".github/scripts/generated.ts";

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  function runner(cwd: string): { status: number; stdout: string; stderr: string } {
    const run = Bun.spawnSync([process.execPath, RUNNER], { cwd, stdout: "pipe", stderr: "pipe" });
    return {
      status: run.exitCode,
      stdout: run.stdout.toString(),
      stderr: run.stderr.toString(),
    };
  }

  test(
    "a clean clone passes; a staged stale byte in a region file and in a whole file fails naming both",
    () =>
      withTempDir("build-check-", (dir) => {
        // HEAD's tree with its own index, sharing the object store and node_modules; the runner and the
        // generators are copied from the working tree, so the code under test is the code being edited.
        git(ROOT, "clone", "--quiet", "--shared", ROOT, dir);
        symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
        cpSync(join(ROOT, ".github", "scripts"), join(dir, ".github", "scripts"), {
          recursive: true,
        });
        const untouched = [".", ":(exclude)node_modules", ":(exclude).github/scripts"];

        const clean = runner(dir);
        expect(clean.stderr).toBe("");
        expect(clean.status).toBe(0);
        expect(clean.stdout).toContain(
          `build:check: ${generatedPaths().length} generated files match their generators`,
        );
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
        expect(stale.stderr).toContain("build:check: generated output drifted");
        expect(stale.stderr).toContain("  modified:  docs/reference/sections.md");
        expect(stale.stderr).toContain("  modified:  src/upstream-gaps/index.ts");
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
