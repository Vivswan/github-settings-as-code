/**
 * The fleet lints with one biome, the version the managed biome.json's $schema URL names, while this repository's
 * own lint, format, and pre-commit hook run the @biomejs/biome devDependency. A Dependabot bump of that devDependency
 * would otherwise lint with a newer biome than the gate, silently: `biome ci` only emits an info notice when the
 * schema lags the CLI.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../root.js";

/** The version segment of a biomejs.dev schema URL, or null when the URL has another shape. */
function biomeSchemaVersion(schemaUrl: string): string | null {
  return schemaUrl.match(/^https:\/\/biomejs\.dev\/schemas\/([^/]+)\/schema\.json$/)?.[1] ?? null;
}

describe("@biomejs/biome devDependency", () => {
  test("is the fleet's biome, the version the managed biome.json's $schema names", () => {
    const biome = JSON.parse(readFileSync(join(ROOT, "biome.json"), "utf8")) as {
      $schema?: string;
    };
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const installed = pkg.devDependencies?.["@biomejs/biome"];
    expect(installed, "package.json has no @biomejs/biome devDependency").toBeDefined();
    const fleet = biomeSchemaVersion(biome.$schema ?? "");
    expect(
      fleet,
      `biome.json $schema "${biome.$schema}" is not a biomejs.dev schema URL`,
    ).not.toBeNull();
    expect(
      installed,
      `@biomejs/biome is pinned at ${installed} but the fleet's biome.json names ${fleet}; the gate lints with the fleet's biome, so pin the devDependency to ${fleet}`,
    ).toBe(fleet as string);
  });
});
