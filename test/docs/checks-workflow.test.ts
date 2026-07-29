/**
 * Structural contract for the openapi-trimmed cache in checks.yml: the check
 * and e2e-smoke jobs each cache the fetched trimmed spec, and a stale key
 * silently restores a spec slice that no longer matches USED_PATHS. So the
 * two keys must stay byte-identical, and the hashFiles list must cover every
 * file test/e2e/openapi/paths.ts derives route data from - the trim script,
 * paths.ts itself, and each of its route-data imports - so adding an import
 * there without extending the key fails here instead of going stale in CI.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");
const PATHS_TS = "test/e2e/openapi/paths.ts";

interface Step {
  uses?: string;
  with?: Record<string, unknown>;
}
interface Workflow {
  jobs: Record<string, { steps?: Step[] }>;
}

/** Every actions/cache key in the workflow that names the trimmed spec. */
function openapiCacheKeys(wf: Workflow): string[] {
  const keys: string[] = [];
  for (const job of Object.values(wf.jobs)) {
    for (const step of job.steps ?? []) {
      const key = step.with?.key;
      if ((step.uses ?? "").startsWith("actions/cache") && typeof key === "string") {
        if (key.includes("openapi-trimmed-")) {
          keys.push(key);
        }
      }
    }
  }
  return keys;
}

/** The quoted file patterns inside the key's hashFiles(...) call. */
function hashFilesPatterns(key: string): string[] {
  const match = key.match(/hashFiles\(([^)]*)\)/);
  expect(match, `cache key has no hashFiles call: ${key}`).not.toBeNull();
  return (match?.[1] ?? "")
    .split(",")
    .map((arg) => arg.trim().replace(/^'|'$/g, ""))
    .filter(Boolean);
}

/**
 * The repo-relative .ts files paths.ts imports route data from (its relative
 * imports, with the compiled .js specifiers mapped back to source). Only
 * single-line static `import ... from "..."` statements are recognized; any
 * other import-ish line (dynamic import(), require, a reformatted multi-line
 * import) fails the assertion below, so an unsupported form extends this
 * parser instead of being silently skipped.
 */
function routeDataImports(): string[] {
  const source = readFileSync(join(ROOT, PATHS_TS), "utf8");
  const specifiers: string[] = [];
  for (const line of source.split("\n")) {
    if (!/\bimport\b|\brequire\(/.test(line)) {
      continue;
    }
    const match = line.match(/^import [^"]*from "([^"]+)";$/);
    expect(
      match,
      `unrecognized import form in ${PATHS_TS}: "${line.trim()}" - teach routeDataImports() to parse it`,
    ).not.toBeNull();
    specifiers.push(match?.[1] ?? "");
  }
  return specifiers
    .filter((spec) => spec.startsWith("."))
    .map((spec) =>
      relative(ROOT, resolve(ROOT, PATHS_TS, "..", spec))
        .split("\\")
        .join("/")
        .replace(/\.js$/, ".ts"),
    );
}

/** True when a file is named by the pattern list, directly or via a ** glob. */
function covered(patterns: string[], file: string): boolean {
  if (patterns.includes(file)) {
    return true;
  }
  return patterns.some(
    (pattern) => pattern.endsWith("/**") && file.startsWith(pattern.slice(0, -2)),
  );
}

describe("checks.yml openapi-trimmed cache keys", () => {
  const wf = parseYaml(
    readFileSync(join(ROOT, ".github", "workflows", "checks.yml"), "utf8"),
  ) as Workflow;
  const keys = openapiCacheKeys(wf);

  test("both consuming jobs cache the spec under byte-identical keys", () => {
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1] as string);
  });

  test("the hashFiles list covers every route-data input of the spec", () => {
    const patterns = hashFilesPatterns(keys[0] ?? "");
    const inputs = [".github/scripts/trim-openapi.ts", PATHS_TS, ...routeDataImports()];
    expect(inputs).toContain("src/report/issue-report.ts");
    expect(patterns).toContain("src/sections/**");
    for (const file of inputs) {
      expect(
        covered(patterns, file),
        `${file} feeds USED_PATHS but the cache key does not hash it`,
      ).toBe(true);
    }
  });
});
