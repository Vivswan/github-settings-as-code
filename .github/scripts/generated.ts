/**
 * The one table of committed generated output, derived from the generators' own registries, and the drift check
 * behind `bun run build:check`: every marker in a registered page must name a registered region, every generator
 * script runs, then every registered path must be tracked and unchanged.
 *
 * The table is in dependency order, each artifact before its readers, or a new gap file would leave a run stale:
 *   the descriptor-derived files -> imported through src/ by everything below
 *   the gaps index               -> imported through src/ by the docs and action.yml generators
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILES } from "./gen-action-docs.js";
import { PAGES } from "./gen-docs.js";
import { INDEX_PATH } from "./gen-gaps-index.js";
import { INPUTS_PAGES } from "./gen-inputs-table.js";
import { OUTPUTS as OPENAPI_OUTPUTS } from "./gen-openapi.js";
import { runMain } from "./lib/entry.js";
import { markerSyntaxFor, regionNames } from "./lib/generated-regions.js";
import type { GeneratedFiles } from "./lib/region-driver.js";

const ROOT = join(import.meta.dir, "..", "..");

/** What a row of either kind carries. */
interface OutputRow {
  /** The committed output, repo-relative. */
  readonly path: string;

  /** The package.json script that writes it; `bun run <generator>` regenerates it in place. */
  readonly generator: string;
}

/** The whole file, or marker-delimited regions inside an authored file (lib/generated-regions.ts) under the names `generator` registers there. */
export type GeneratedOutput = OutputRow &
  ({ readonly kind: "file" } | { readonly kind: "regions"; readonly regions: readonly string[] });

function regions(generator: string, files: GeneratedFiles): GeneratedOutput[] {
  return Object.entries(files).map(([path, file]) => ({
    path,
    generator,
    kind: "regions",
    regions: file.regions.map((region) => region.name),
  }));
}

/** In the module doc's dependency order; a page two generators write into (docs/reference/inputs.md) has one row per generator. */
export const GENERATED_OUTPUTS: readonly GeneratedOutput[] = [
  ...OPENAPI_OUTPUTS.map(
    ({ path }): GeneratedOutput => ({ path, generator: "build:openapi", kind: "file" }),
  ),
  { path: INDEX_PATH, generator: "build:gaps-index", kind: "file" },
  ...regions("build:docs", PAGES),
  ...regions("build:action-docs", FILES),
  ...regions("build:inputs-table", INPUTS_PAGES),
];

/** The distinct paths, in table order. */
export function generatedPaths(): string[] {
  return [...new Set(GENERATED_OUTPUTS.map((output) => output.path))];
}

/** The distinct generator scripts, in run order. */
export function generatorScripts(): string[] {
  return [...new Set(GENERATED_OUTPUTS.map((output) => output.generator))];
}

/** The repository file a generator script runs (`bun <file>.ts`), or null for any other shape, which the tests
 * refuse rather than drop from their census. */
export function generatorEntryPoint(script: string): string | null {
  return /^bun (\S+\.ts)$/.exec(script)?.[1] ?? null;
}

/** One line per BEGIN marker in a registered page that names no region a generator registers there: nothing
 * regenerates such a region, so its body would go stale unseen. */
function unregisteredRegions(): string[] {
  const pages = GENERATED_OUTPUTS.filter((output) => output.kind === "regions");
  return [...Map.groupBy(pages, (output) => output.path)].flatMap(([path, rows]) => {
    const registered = new Set(rows.flatMap((row) => row.regions));
    const marked = regionNames(readFileSync(join(ROOT, path), "utf8"), markerSyntaxFor(path));
    return marked
      .filter((name) => !registered.has(name))
      .map(
        (name) =>
          `${path} marks a generated region "${name}" that no generator registers; register it with a generator, or remove its GENERATED markers`,
      );
  });
}

/** Runs `argv` at the repository root on the terminal's stdio; the exit code is the verdict. */
function run(argv: string[]): number {
  return Bun.spawnSync(argv, { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode;
}

if (import.meta.main) {
  await runMain("generated", () => {
    const unregistered = unregisteredRegions();
    if (unregistered.length > 0) {
      console.error(`build:check: ${unregistered.join("\nbuild:check: ")}`);
      return 1;
    }
    for (const generator of generatorScripts()) {
      if (run([process.execPath, "run", generator]) !== 0) {
        console.error(`build:check: bun run ${generator} failed`);
        return 1;
      }
    }
    const paths = generatedPaths();
    // Working tree against the index: a regenerated file already staged passes, a stale one fails. git lists the
    // drifted paths itself; an untracked registered path is listed the same way.
    const untracked = Bun.spawnSync(
      ["git", "ls-files", "--others", "--exclude-standard", "--", ...paths],
      { cwd: ROOT, stderr: "inherit" },
    );
    if (untracked.exitCode !== 0) {
      console.error("build:check: git ls-files failed");
      return 1;
    }
    const drifted = run(["git", "diff", "--exit-code", "--stat", "--", ...paths]) !== 0;
    if (drifted || untracked.stdout.length > 0) {
      process.stdout.write(untracked.stdout);
      console.error(
        "build:check: the generated output listed above drifted from the committed tree; run bun run build and commit it",
      );
      return 1;
    }
    console.log(`build:check: ${paths.length} generated files match their generators`);
  });
}
