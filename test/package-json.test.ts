import { describe, expect, test } from "bun:test";
import manifest from "../.release-please-manifest.json";
import pkg from "../package.json";

/**
 * package.json is the npm manifest of @vivswan/github-settings-as-code as
 * well as the toolchain's script table, so its publishable shape is pinned:
 * the field set, the version's mirror of the release-please manifest, the
 * exports map, the shipped files, and which packages are runtime
 * dependencies (the action-only ones stay dev: the action bundle inlines
 * them, the library never imports them).
 */
describe("package.json as the npm manifest", () => {
  test("mirrors the release-please manifest version", () => {
    // release-please's json updater rewrites $.version on every release; the
    // manifest is its source of truth, so the two must agree on main.
    expect(pkg.version).toBe(manifest["."]);
  });

  test("carries exactly the pinned fields, in order", () => {
    expect(Object.keys(pkg)).toEqual([
      "name",
      "version",
      "description",
      "license",
      "type",
      "repository",
      "engines",
      "sideEffects",
      "exports",
      "files",
      "publishConfig",
      "scripts",
      "dependencies",
      "devDependencies",
    ]);
  });

  test("publishes publicly under the scoped name as an ESM package", () => {
    expect(pkg.name).toBe("@vivswan/github-settings-as-code");
    expect("private" in pkg).toBe(false);
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.type).toBe("module");
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.engines).toEqual({ node: ">=22.14" });
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/Vivswan/github-settings-as-code.git",
    });
  });

  test("exports the library build, the schema, and its own manifest", () => {
    expect(pkg.exports).toEqual({
      ".": { types: "./lib/pkg/index.d.ts", default: "./lib/pkg/index.js" },
      "./settings.schema.json": "./lib/settings.schema.json",
      "./package.json": "./package.json",
    });
    // No bin yet: a CLI is its own change, with its own smoke.
    expect("bin" in pkg).toBe(false);
  });

  test("ships the library build, the schema, the license, and the README only", () => {
    expect(pkg.files).toEqual(["lib/pkg/", "lib/settings.schema.json", "LICENSE.md", "README.md"]);
  });

  test("keeps the action-only packages out of the runtime dependencies", () => {
    for (const name of ["@actions/artifact", "@actions/core"]) {
      expect(name in pkg.dependencies, `${name} is a runtime dependency`).toBe(false);
      expect(name in pkg.devDependencies, `${name} is missing from devDependencies`).toBe(true);
    }
  });

  test("builds the library after the action bundle, and prepare tolerates a missing lefthook", () => {
    expect(pkg.scripts["build:lib"]).toBe("bun x tsdown");
    expect(pkg.scripts.build.startsWith("bun run build:bundle && bun run build:lib && ")).toBe(
      true,
    );
    // A `github:` install runs prepare in a tree without lefthook installed.
    expect(pkg.scripts.prepare).toBe("lefthook install || true");
  });
});
