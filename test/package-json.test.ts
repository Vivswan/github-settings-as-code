/**
 * package.json is the npm manifest of @vivswan/github-settings-as-code; each test here relates one of its publishable values to the artifact that
 * consumes it, so a value that drifts fails at commit time instead of at the release's npm publish or on a consumer's machine.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { parse as parseYaml } from "yaml";
import manifest from "../.release-please-manifest.json";
import schema from "../lib/settings.schema.json" with { type: "json" };
import pkg from "../package.json";
import tsdown from "../tsdown.config.js";
import { ROOT } from "./root.js";

/** tsdown types its options loosely (a glob, a list, or a map); this config is the map form. */
const build = tsdown as { entry: Record<string, string>; outDir: string };

/** Every package the library entries reach through static imports and re-exports, type-only ones included (the bundled .d.ts names them). */
function packagesImportedByTheLibrary(): string[] {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = Object.values(build.entry).map((entry) => join(ROOT, entry));
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const { module } = parseSync(file, readFileSync(file, "utf8"));
    const specifiers = [
      ...module.staticImports.map((entry) => entry.moduleRequest.value),
      ...module.staticExports.flatMap((entry) =>
        entry.entries.flatMap((item) => (item.moduleRequest ? [item.moduleRequest.value] : [])),
      ),
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      } else if (!specifier.startsWith("node:")) {
        const segments = specifier.startsWith("@") ? 2 : 1;
        packages.add(specifier.split("/").slice(0, segments).join("/"));
      }
    }
  }
  return [...packages].sort();
}

describe("package.json as the npm manifest", () => {
  test("mirrors the release-please manifest version", () => {
    // release-please's json updater rewrites $.version on every release; the manifest is its source of truth, so the two must agree on main.
    expect(pkg.version).toBe(manifest["."]);
  });

  test("publishes a public scoped package from the repository the schema names", () => {
    // post-green.yml (publish-next) and update-release.yml (publish-npm) run a bare `npm publish` under trusted publishing: a scoped package
    // publishes restricted without publishConfig.access, and provenance verifies repository.url against the workflow's repository.
    expect("private" in pkg).toBe(false);
    expect(pkg.publishConfig).toEqual({ access: "public" });
    const [owner, repo] = new URL(schema.$id).pathname.split("/").filter(Boolean);
    expect(pkg.repository).toEqual({
      type: "git",
      url: `git+https://github.com/${owner}/${repo}.git`,
    });
  });

  test("the exports map and the bins name exactly the library build, the schema, and the manifest", () => {
    const built = Object.keys(build.entry).map((name) => `./${build.outDir}/${name}.js`);
    const targets = [
      ...Object.values(pkg.exports).map((entry) =>
        typeof entry === "string" ? entry : entry.default,
      ),
      ...Object.values(pkg.bin).map((bin) => `./${bin}`),
    ];
    expect(targets.filter((target) => !built.includes(target)).sort()).toEqual([
      "./lib/settings.schema.json",
      "./package.json",
    ]);
    expect(built.filter((module) => !targets.includes(module))).toEqual([]);
    // The bin NAMES are public too: the library page's CLI section names every bin entry, and both must run the one CLI build.
    const page = readFileSync(join(ROOT, "docs/reference/library.md"), "utf8");
    const sentence =
      page.match(/The package's `bin` entries, (.+?), run the same flows/)?.[1] ?? "";
    const documentedBins = [...sentence.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1] ?? "")
      .sort();
    expect(documentedBins).not.toEqual([]);
    expect(Object.keys(pkg.bin).sort()).toEqual(documentedBins);
    expect(new Set(Object.values(pkg.bin)).size).toBe(1);
    const declarations: string[] = [];
    for (const entry of Object.values(pkg.exports)) {
      if (typeof entry !== "string") {
        expect(entry.types).toBe(entry.default.replace(/\.js$/, ".d.ts"));
        declarations.push(entry.types);
      }
    }
    // npm packs `files` (and the manifest, always), so a target outside them installs as a dangling path. An entry names a file or a directory,
    // with or without a trailing slash.
    for (const target of [...targets, ...declarations].filter((t) => t !== "./package.json")) {
      const shipped = pkg.files.some((entry) => {
        const path = `./${entry.replace(/\/$/, "")}`;
        return target === path || target.startsWith(`${path}/`);
      });
      expect(shipped, target).toBe(true);
    }
  });

  test("the runtime dependencies are exactly the packages the library entries import", () => {
    // tsdown externalizes `dependencies`, so the consumer's package manager installs them beside lib/pkg/; the action bundle inlines everything,
    // so a package only src/action/ or src/main.ts uses (@actions/core, @actions/artifact) stays a devDependency.
    expect(packagesImportedByTheLibrary()).toEqual(Object.keys(pkg.dependencies).sort());
  });

  test("the engines floor is the node the package smoke runs the consumer on", () => {
    const checks = parseYaml(readFileSync(join(ROOT, ".github/workflows/checks.yml"), "utf8")) as {
      jobs: { "package-smoke": { strategy: { matrix: { "node-version": string[] } } } };
    };
    const floor = pkg.engines.node.match(/^>=(\d+\.\d+)$/)?.[1] ?? "";
    expect(floor).not.toBe("");
    expect(checks.jobs["package-smoke"].strategy.matrix["node-version"]).toContain(floor);
  });
});
