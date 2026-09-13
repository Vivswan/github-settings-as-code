import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_OUTPUTS, generatedPaths } from "../../.github/scripts/generated.js";
import { ROOT } from "../root.js";

/** A generated-region marker in either comment syntax, opening a line. */
const BEGIN_MARKER = /^[ \t]*(?:<!-- |# )BEGIN GENERATED: /m;
/** The file types generated-regions.ts has a marker syntax for; a marker string anywhere else is test or script text. */
const REGION_FILE = /\.(?:md|ya?ml)$/;

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((path) => path !== "");

describe("the generated-output table", () => {
  const carrying = tracked.filter(
    (path) => REGION_FILE.test(path) && BEGIN_MARKER.test(readFileSync(join(ROOT, path), "utf8")),
  );
  /** The outputs the marker scan cannot see: whole generated files. */
  const WHOLE_FILES = ["lib/settings.schema.json", "src/upstream-gaps/index.ts"];

  test("holds exactly the tracked files that carry a generated-region marker", () => {
    const registered = GENERATED_OUTPUTS.filter((output) => output.kind === "regions").map(
      (output) => output.path,
    );
    expect([...new Set(registered)].sort()).toEqual(carrying.sort());
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
