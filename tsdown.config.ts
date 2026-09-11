/**
 * The library build: src/index.ts bundled to lib/pkg/ as one ESM module with
 * one bundled index.d.ts. Runtime dependencies stay external (the consumer's
 * package manager installs them); the action bundle (bun run build:bundle)
 * is a separate artifact that inlines everything.
 */

import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: "src/index.ts",
  format: "esm",
  platform: "node",
  dts: true,
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
