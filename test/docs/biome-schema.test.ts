/**
 * biome.json's $schema URL names a biome version by hand, and `biome ci` only
 * emits an info notice when it lags the installed CLI, so a dependency bump
 * leaves it drifting silently. Pin the two together here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** The version segment of a biomejs.dev schema URL, or null when the URL has another shape. */
function biomeSchemaVersion(schemaUrl: string): string | null {
  return schemaUrl.match(/^https:\/\/biomejs\.dev\/schemas\/([^/]+)\/schema\.json$/)?.[1] ?? null;
}

describe("biome.json $schema", () => {
  test("names the installed @biomejs/biome version", () => {
    const biome = JSON.parse(readFileSync(join(ROOT, "biome.json"), "utf8")) as {
      $schema?: string;
    };
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const installed = pkg.devDependencies?.["@biomejs/biome"];
    expect(installed, "package.json has no @biomejs/biome devDependency").toBeDefined();
    const pinned = biomeSchemaVersion(biome.$schema ?? "");
    expect(
      pinned,
      `biome.json $schema "${biome.$schema}" is not a biomejs.dev schema URL`,
    ).not.toBeNull();
    expect(
      pinned,
      `biome.json $schema names ${pinned} but @biomejs/biome is ${installed}; run \`bun x biome migrate --write\``,
    ).toBe(installed as string);
  });
});
