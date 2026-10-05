/**
 * Lints a fixture tree under the repository's own biome.json and every plugin it names, so a plugin's test pins the
 * configuration's wiring (reach, exemptions) along with the pattern.
 *
 *   the fixture tree is the root        -> the `overrides` globs resolve against it; `vcs.useIgnoreFile` wants a git repository there
 *   the root sits under a `src/` parent -> a glob matching the absolute path would reach every file src/** excludes
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../root.js";

const BIOME = join(ROOT, "node_modules", ".bin", "biome");

interface BiomeConfiguration {
  plugins?: string[];
  overrides?: { plugins?: string[] }[];
}

const CONFIGURATION = (() => {
  const biomeJson = readFileSync(join(ROOT, "biome.json"), "utf8");
  const config = JSON.parse(biomeJson) as BiomeConfiguration;
  const plugins = [
    ...(config.plugins ?? []),
    ...(config.overrides ?? []).flatMap((override) => override.plugins ?? []),
  ];
  const entries: [string, string][] = [
    ["biome.json", biomeJson],
    ...plugins.map((path): [string, string] => [path, readFileSync(join(ROOT, path), "utf8")]),
  ];
  return Object.fromEntries(entries);
})();

interface Diagnostic {
  category: string;
  message: string;
  location: { path: string; start: { line: number } };
}

/**
 * `path:line -> "category: message"`, one entry per line; when a line also carries a built-in rule's diagnostic
 * (a throw inside finally trips noUnsafeFinally too), the plugin's wins, since the plugin is what these tests pin.
 */
export function lint(tmp: string, files: Record<string, string>): Record<string, string> {
  const dir = join(tmp, "src", "checkout");
  for (const [path, text] of Object.entries({ ...CONFIGURATION, ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  spawnSync("git", ["init", "--quiet"], { cwd: dir });
  const run = spawnSync(BIOME, ["lint", "--reporter=json", "--no-errors-on-unmatched", "."], {
    cwd: dir,
    encoding: "utf8",
  });
  if (run.stdout === "") {
    throw new Error(`biome wrote no report: ${run.stderr}`);
  }
  const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] };
  const byLine: Record<string, string> = {};
  for (const d of diagnostics) {
    const key = `${d.location.path}:${d.location.start.line}`;
    if (!(key in byLine) || d.category === "plugin") {
      byLine[key] = `${d.category}: ${d.message}`;
    }
  }
  return byLine;
}
