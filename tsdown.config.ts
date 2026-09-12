/**
 * The library build: src/index.ts bundled to lib/pkg/ as one ESM module with
 * one bundled index.d.ts, and src/cli.ts beside it as lib/pkg/cli.js (the bin
 * entry; tsdown keeps its shebang and marks it executable), importing the
 * library module rather than inlining it. Runtime dependencies stay external
 * (the consumer's package manager installs them); the action bundle (bun run
 * build:bundle) is a separate artifact that inlines everything.
 */

import { rmSync } from "node:fs";
import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  dts: true,
  hooks: {
    // The bin has no importable surface; its declaration file would be an empty `export {}`.
    "build:done": () => rmSync("lib/pkg/cli.d.ts", { force: true }),
  },
  outDir: "lib/pkg",
  deps: {
    // tsdown already externalizes package.json dependencies and their subpaths
    // ("bottleneck/light.js" included); naming them keeps that choice explicit.
    neverBundle: Object.keys(pkg.dependencies),
  },
  sourcemap: false,
  // index.js and index.d.ts, not .mjs/.d.mts: package.json declares type module.
  fixedExtension: false,
  clean: true,
});
