/**
 * The library build: src/index.ts bundled to lib/pkg/ as one ESM module with
 * one bundled index.d.ts. Runtime dependencies stay external (the consumer's
 * package manager installs them); the action bundle (bun run build:bundle)
 * is a separate artifact that inlines everything.
 */

import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

const runtimeDependencies = Object.keys(pkg.dependencies);

export default defineConfig({
  entry: "src/index.ts",
  format: "esm",
  platform: "node",
  dts: true,
  outDir: "lib/pkg",
  deps: {
    // Bare specifiers and their subpaths ("pkg" and "pkg/anything").
    neverBundle: runtimeDependencies.flatMap((name) => [
      name,
      new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`),
    ]),
  },
  sourcemap: false,
  // index.js and index.d.ts, not .mjs/.d.mts: package.json declares type module.
  fixedExtension: false,
  clean: true,
});
