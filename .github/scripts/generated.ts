/**
 * The one table of committed generated output, derived from the generators' own registries, and the drift check
 * behind `bun run build:check`: every generator script runs, then every registered path must be tracked and unchanged.
 */

import { join } from "node:path";
import { FILES } from "./gen-action-docs.js";
import { PAGES } from "./gen-docs.js";
import { INDEX_PATH } from "./gen-gaps-index.js";
import { INPUTS_PAGE_PATH } from "./gen-inputs-table.js";
import { runMain } from "./lib/entry.js";

const ROOT = join(import.meta.dir, "..", "..");

export interface GeneratedOutput {
  /** The committed output, repo-relative. */
  readonly path: string;
  /** The package.json script that writes it; `bun run <generator>` regenerates it in place. */
  readonly generator: string;
  /** Marker-delimited regions inside an authored file (lib/generated-regions.ts), or the whole file. */
  readonly kind: "regions" | "file";
}

function regions(generator: string, paths: readonly string[]): GeneratedOutput[] {
  return paths.map((path) => ({ path, generator, kind: "regions" }));
}

/**
 * A page two generators write into (docs/reference/inputs.md) has one row per generator. Rows stay in dependency
 * order, each artifact before its readers, or a new gap file would leave a run stale.
 *   the gaps index -> imported through src/ by the docs and action.yml generators
 */
export const GENERATED_OUTPUTS: readonly GeneratedOutput[] = [
  { path: INDEX_PATH, generator: "build:gaps-index", kind: "file" },
  ...regions("build:docs", Object.keys(PAGES)),
  ...regions("build:action-docs", Object.keys(FILES)),
  { path: INPUTS_PAGE_PATH, generator: "build:inputs-table", kind: "regions" },
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

/** Runs `argv` at the repository root on the terminal's stdio; the exit code is the verdict. */
function run(argv: string[]): number {
  return Bun.spawnSync(argv, { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode;
}

if (import.meta.main) {
  await runMain("generated", () => {
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
