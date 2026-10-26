/**
 * Lints a fixture tree under the repository's own biome configuration, every layer biome.json extends and every
 * plugin a layer names, so a plugin's test pins the configuration's wiring (reach, exemptions) along with the pattern.
 *
 *   the fixture tree is the root        -> the `overrides` globs resolve against it; `vcs.useIgnoreFile` wants a git repository there
 *   the root sits under a `src/` parent -> a glob matching the absolute path would reach every file src/** excludes
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../root.js";

const BIOME = join(ROOT, "node_modules", ".bin", "biome");

/** The keys of a biome layer the copy follows: the layers it extends, and the plugins it or its overrides name. */
interface BiomeLayer {
  extends?: string[];
  plugins?: string[];
  overrides?: { plugins?: string[] }[];
}

interface Diagnostic {
  category: string;
  message: string;
  location: { path: string; start: { line: number } };
}

/**
 * Every configuration layer from biome.json down its `extends` chain, and every plugin any layer names, keyed by
 * repository-relative path. An extended path is relative to the layer naming it; a plugin path is relative to the root.
 */
function configurationFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const layers = ["biome.json"];
  for (const path of layers) {
    const text = readFileSync(join(ROOT, path), "utf8");
    files[path] = text;

    const layer = Bun.JSONC.parse(text) as BiomeLayer;
    layers.push(...(layer.extends ?? []).map((extended) => join(dirname(path), extended)));
    const plugins = [
      ...(layer.plugins ?? []),
      ...(layer.overrides ?? []).flatMap((override) => override.plugins ?? []),
    ];
    for (const plugin of plugins) {
      files[plugin] = readFileSync(join(ROOT, plugin), "utf8");
    }
  }

  return files;
}

/**
 * `path:line -> "category: message"`, one entry per line; when a line also carries a built-in rule's diagnostic
 * (a throw inside finally trips noUnsafeFinally too), the plugin's wins, since the plugin is what these tests pin.
 */
export function lint(tmp: string, files: Record<string, string>): Record<string, string> {
  const dir = join(tmp, "src", "checkout");
  for (const [path, text] of Object.entries({ ...configurationFiles(), ...files })) {
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
