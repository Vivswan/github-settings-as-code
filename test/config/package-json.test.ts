/**
 * package.json is the npm manifest of @vivswan/github-settings-as-code; each test here relates one of its publishable values to the artifact that
 * consumes it, so a value that drifts fails at commit time instead of at the release's npm publish or on a consumer's machine.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSync } from "oxc-parser";
import { publint } from "publint";
import { formatMessage } from "publint/utils";
import { parse as parseYaml } from "yaml";
import manifest from "../../.release-please-manifest.json";
import pkg from "../../package.json";
import tsdown from "../../tsdown.config.js";
import { ROOT } from "../root.js";
import { readSettingsSchema } from "../settings-schema.js";
import { withTempDir } from "../temp-dir.js";

/** The built lib/settings.schema.json, whose $id names the repository the package must point at. */
const schema = readSettingsSchema();

/** tsdown types its options loosely (a glob, a list, or a map); this config is the map form. */
const build = tsdown as { entry: Record<string, string>; outDir: string };

/** The two fields the publish checks read, so a hand-made variant of `pkg` is a manifest too. */
interface Manifest {
  readonly exports: Readonly<Record<string, string | { types: string; default: string }>>;
  readonly bin: Readonly<Record<string, string>>;
}

/** The export targets and the bin paths `manifest` names, each as a ./-relative path. */
function manifestTargets(manifest: Manifest): string[] {
  return [
    ...Object.values(manifest.exports).map((entry) =>
      typeof entry === "string" ? entry : entry.default,
    ),
    ...Object.values(manifest.bin).map((bin) => `./${bin}`),
  ];
}

function manifestDeclarations(manifest: Manifest): string[] {
  return Object.values(manifest.exports).flatMap((entry) =>
    typeof entry === "string" ? [] : [entry.types],
  );
}

/** The import paths the library page's entry table names, plus the two its trailing sentence says ride along, sorted. */
function documentedExportPaths(page: string): string[] {
  const entries = page.match(/^## The two entries\n([\s\S]*?)^## /m)?.[1] ?? "";
  const importPaths = [
    ...entries.matchAll(/^\| `@vivswan\/github-settings-as-code(\/[^`]+)?` \|/gm),
  ].map((match) => `.${match[1] ?? ""}`);
  const rideAlong = entries.match(/Two more paths ride along: (.+)$/m)?.[1] ?? "";
  return [
    ...importPaths,
    ...[...rideAlong.matchAll(/`(\.\/[^`]+)`/g)].map((match) => match[1] ?? ""),
  ].sort();
}

/** The bin names the library page's CLI sentence lists, sorted. */
function documentedBinNames(page: string): string[] {
  const sentence = page.match(/The package's `bin` entries, (.+?), run the same flows/)?.[1] ?? "";
  return [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "").sort();
}

/**
 * What publint reports for `manifest` once npm, the publisher, has packed it; warnings count as errors, as lint:package
 * runs it. A scratch package holds the manifest and an empty stub at every file it points a consumer at (a bin stub
 * carries the shebang publint requires), so the judgment is the manifest's shape and npm's pack list, not the build.
 */
async function manifestMessages(manifest: Manifest): Promise<string[]> {
  return withTempDir("gsac-manifest-", async (dir) => {
    const bins = Object.values(manifest.bin).map((bin) => `./${bin}`);
    for (const file of [...manifestTargets(manifest), ...manifestDeclarations(manifest)]) {
      if (file === "./package.json") {
        continue;
      }
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      writeFileSync(join(dir, file), bins.includes(file) ? "#!/usr/bin/env node\n" : "");
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    const { messages } = await publint({
      pkgDir: dir,
      pack: "npm",
      level: "warning",
      strict: true,
    });
    return messages.map(
      (message) => formatMessage(message, manifest, { color: false }) ?? message.code,
    );
  });
}

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

  test("names the repository the schema names", () => {
    // update-release-pr.yml (publish-next) and update-release.yml (publish-npm) publish under trusted publishing, whose provenance verifies
    // repository.url against the workflow's repository.
    const [owner, repo] = new URL(schema.$id).pathname.split("/").filter(Boolean);
    expect(pkg.repository).toEqual({
      type: "git",
      url: `git+https://github.com/${owner}/${repo}.git`,
    });
  });

  test("the exports map and the bins name exactly the library build, the schema, and the manifest", () => {
    const built = Object.keys(build.entry).map((name) => `./${build.outDir}/${name}.js`);
    const targets = manifestTargets(pkg);
    expect(targets.filter((target) => !built.includes(target)).sort()).toEqual([
      "./lib/settings.schema.json",
      "./package.json",
    ]);
    expect(built.filter((module) => !targets.includes(module))).toEqual([]);
    // The KEYS are public too: the library page's entry table names every import path and its trailing sentence the two paths that ride along.
    const page = readFileSync(join(ROOT, "docs/reference/library.md"), "utf8");
    const documentedPaths = documentedExportPaths(page);
    expect(documentedPaths).not.toEqual([]);
    expect(Object.keys(pkg.exports).sort()).toEqual(documentedPaths);
    // The bin NAMES likewise: the CLI section names every bin entry, and both must run the one CLI build.
    const documentedBins = documentedBinNames(page);
    expect(documentedBins).not.toEqual([]);
    expect(Object.keys(pkg.bin).sort()).toEqual(documentedBins);
    // The bins run the CLI entry and each module export its namesake entry, so a swapped target cannot pass as "some built module".
    expect(new Set(Object.values(pkg.bin))).toEqual(new Set([`${build.outDir}/cli.js`]));
    for (const [key, entry] of Object.entries(pkg.exports)) {
      if (typeof entry === "string") {
        // The two file subpaths serve the file they are named after, so the schema key cannot serve the manifest.
        expect(entry, key).toEndWith(key.slice(1));
      } else {
        expect(entry.default, key).toBe(
          `./${build.outDir}/${key === "." ? "index" : key.slice(2)}.js`,
        );
      }
    }
    for (const entry of Object.values(pkg.exports)) {
      if (typeof entry === "string") {
        continue;
      }
      expect(entry.types).toBe(entry.default.replace(/\.js$/, ".d.ts"));
    }
  });

  test("npm's pack list holds every file the manifest points at, and publint has nothing else to say", async () => {
    // npm packs `files`, the manifest, README, LICENSE, and every bin, so a target outside them installs as a dangling path.
    expect(await manifestMessages(pkg)).toEqual([]);
  });

  test("an export target outside `files` is reported as unpublished (negative control)", async () => {
    const manifest = { ...pkg, exports: { ...pkg.exports, "./extra": "./dist/extra.js" } };
    expect(await manifestMessages(manifest)).toEqual([
      'pkg.exports["./extra"] is ./dist/extra.js but the file is not published. Is it specified in pkg.files?',
    ]);
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
