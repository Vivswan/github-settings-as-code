/**
 * The one table of committed generated output, derived from the generators' own registries, and the drift check
 * behind `bun run build:check`: every generator runs, then every registered path must be tracked and unchanged.
 */

import { join } from "node:path";
import { GENERATED_REGIONS } from "./gen-action-docs.js";
import { COVERAGE_PATH, PAGE_REGIONS } from "./gen-docs.js";
import { INDEX_PATH } from "./gen-gaps-index.js";

const ROOT = join(import.meta.dir, "..", "..");

export interface GeneratedOutput {
  /** The committed output, repo-relative. */
  readonly path: string;
  /** The script that writes it, repo-relative; `bun <generator>` regenerates it in place. */
  readonly generator: string;
  /** Marker-delimited regions inside an authored file (lib/generated-regions.ts), or the whole file. */
  readonly kind: "regions" | "file";
}

function regions(generator: string, paths: readonly string[]): GeneratedOutput[] {
  return paths.map((path) => ({ path, generator, kind: "regions" }));
}

/** A page two generators write into (docs/reference/inputs.md) has one row per generator. Table order is run order. */
export const GENERATED_OUTPUTS: readonly GeneratedOutput[] = [
  {
    path: "lib/settings.schema.json",
    generator: ".github/scripts/gen-settings-schema.ts",
    kind: "file",
  },
  ...regions(".github/scripts/gen-docs.ts", [COVERAGE_PATH, ...Object.keys(PAGE_REGIONS)]),
  ...regions(".github/scripts/gen-action-docs.ts", Object.keys(GENERATED_REGIONS)),
  { path: INDEX_PATH, generator: ".github/scripts/gen-gaps-index.ts", kind: "file" },
];

/** The distinct paths, in table order. */
export function generatedPaths(): string[] {
  return [...new Set(GENERATED_OUTPUTS.map((output) => output.path))];
}

/** Runs `argv` at the repository root on the terminal's stdio; the exit code is the verdict. */
function run(argv: string[]): number {
  return Bun.spawnSync(argv, { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode;
}

if (import.meta.main) {
  for (const generator of new Set(GENERATED_OUTPUTS.map((output) => output.generator))) {
    if (run([process.execPath, generator]) !== 0) {
      console.error(`build:check: ${generator} failed`);
      process.exit(1);
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
    process.exit(1);
  }
  const drifted = run(["git", "diff", "--exit-code", "--stat", "--", ...paths]) !== 0;
  if (drifted || untracked.stdout.length > 0) {
    process.stdout.write(untracked.stdout);
    console.error(
      "build:check: generated output drifted from the committed tree; commit the files listed above",
    );
    process.exit(1);
  }
  console.log(`build:check: ${paths.length} generated files match their generators`);
}
