/**
 * Graduate upstream-gap files whose routes @octokit/types now ships. Each file
 * under src/upstream-gaps/ carries a tripwire type that makes
 * `bun x tsc -p . --noEmit` fail with TS2344 inside that file the moment
 * upstream types one of its routes. This script turns that red build back
 * green: it deletes every tripped gap file and removes the file's import and
 * array-element lines from src/upstream-gaps/index.ts, whose layout is
 * script-owned (exactly one import line and one element line per gap, in the
 * shapes matched below).
 *
 * Run: `bun .github/scripts/graduate-upstream-gaps.ts` (from anywhere; it
 * compiles the repo root). A clean compile means nothing to graduate. Any
 * diagnostic that is not a TS2344 inside a gap file aborts the run untouched:
 * something else is broken, and a half-fix would bury it. A re-compile after
 * the deletions must be green, or the run aborts for a human (a gap file whose
 * routes shipped only partially must be split by hand; `git checkout --
 * src/upstream-gaps` restores the tree).
 *
 * TypeScript 7 (tsgo) has no in-process compiler API, so the CLI plus
 * diagnostic-line parsing IS the design, not a stopgap.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const GAPS_DIR = "src/upstream-gaps";
const INDEX_PATH = `${GAPS_DIR}/index.ts`;

/**
 * The directory's infrastructure files: the index and the shared gap
 * machinery. Neither carries a tripwire, so neither is ever graduatable.
 */
const NON_GAP_FILES = new Set([INDEX_PATH, `${GAPS_DIR}/gap.ts`]);

/** One parsed `file(line,col): error TSnnnn: message` compiler line. */
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
}

/** What the diagnostics demand: the gap files to delete, and everything else. */
export interface GraduationPlan {
  /** Gap-file paths (repo-relative, deduplicated, sorted) with a TS2344. */
  gapFiles: string[];
  /** Diagnostics the script must not fix: wrong code, or outside a gap file. */
  foreign: Diagnostic[];
}

/**
 * Parse `--pretty false` compiler output. Chained diagnostics continue on
 * indented lines ("The types of 'a.b' are incompatible..."), which belong to
 * the diagnostic above them. Non-empty lines that are neither diagnostics nor
 * continuations (a crash trace, a config error without a location) come back
 * in `unparsed` so the caller can refuse to act on output it does not
 * understand.
 */
export function parseDiagnostics(output: string): {
  diagnostics: Diagnostic[];
  unparsed: string[];
} {
  const diagnostics: Diagnostic[] = [];
  const unparsed: string[] = [];
  let current: Diagnostic | undefined;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
      continue;
    }
    const match = /^(.+)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    if (match) {
      current = {
        file: match[1] as string,
        line: Number(match[2]),
        column: Number(match[3]),
        code: Number(match[4]),
        message: match[5] as string,
      };
      diagnostics.push(current);
      continue;
    }
    if (/^\s/.test(line) && current) {
      current.message += `\n${line}`;
      continue;
    }
    current = undefined;
    unparsed.push(line);
  }
  return { diagnostics, unparsed };
}

/**
 * True for a path this script may graduate: a .ts file directly under
 * src/upstream-gaps/ that is not one of the directory's infrastructure files
 * (index.ts, gap.ts). A TS2344 anywhere else is foreign.
 */
export function isGapFile(file: string): boolean {
  if (!file.startsWith(`${GAPS_DIR}/`) || NON_GAP_FILES.has(file)) {
    return false;
  }
  const rest = file.slice(`${GAPS_DIR}/`.length);
  return rest.endsWith(".ts") && !rest.includes("/");
}

/** Split diagnostics into graduatable gap files and foreign noise. */
export function planGraduation(diagnostics: readonly Diagnostic[]): GraduationPlan {
  const gapFiles = new Set<string>();
  const foreign: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.code === 2344 && isGapFile(diagnostic.file)) {
      gapFiles.add(diagnostic.file);
    } else {
      foreign.push(diagnostic);
    }
  }
  return { gapFiles: [...gapFiles].sort(), foreign };
}

/** "merge-queue" -> "mergeQueue": the index's import alias for a gap file. */
export function camelCaseGapName(base: string): string {
  return base.replace(/-([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

/**
 * A gap whose routes the published OpenAPI description does not document
 * yet (documentedInSpec: false) rides two upstream lifecycles: deleting it
 * on octokit's say-so alone would also drop its UNDOCUMENTED_ROUTES
 * exemption while the pinned descriptor still lacks the paths, and
 * trim-openapi would fail on the next fetch. That graduation needs a human
 * (bump UPSTREAM_REF, flip the flag, regenerate the trimmed spec).
 */
export function isSpecPinned(gapSource: string): boolean {
  return /documentedInSpec:\s*false/.test(gapSource);
}

/** Drop exactly one full-line occurrence of `target` from `lines`, loudly. */
function removeExactLine(lines: string[], target: string, indexPath: string): string[] {
  const hits = lines.filter((line) => line === target).length;
  if (hits !== 1) {
    throw new Error(
      `expected exactly one line \`${target}\` in ${indexPath}, found ${hits}. ` +
        `The index layout is script-owned (one import and one array element per gap file); ` +
        `restore that layout by hand before re-running`,
    );
  }
  return lines.filter((line) => line !== target);
}

/**
 * Remove a graduated gap file's two index lines: the import
 * `import { GAP as <camel> } from "./<base>.js";` and the array element
 * `  <camel>,`. Each must match exactly once, or the layout has drifted from
 * the script-owned shape and the run aborts untouched.
 */
export function removeGapFromIndex(source: string, gapFile: string): string {
  const base = gapFile.slice(`${GAPS_DIR}/`.length).replace(/\.ts$/, "");
  const alias = camelCaseGapName(base);
  let lines = source.split("\n");
  lines = removeExactLine(lines, `import { GAP as ${alias} } from "./${base}.js";`, INDEX_PATH);
  lines = removeExactLine(lines, `  ${alias},`, INDEX_PATH);
  return lines.join("\n");
}

/** Compile the repo; diagnostics land on stdout, tool failures on stderr. */
function runTsc(): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", "x", "tsc", "-p", ".", "--noEmit", "--pretty", "false"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function abort(reason: string, ...raw: string[]): never {
  for (const chunk of raw) {
    if (chunk.trim() !== "") {
      console.error(chunk.trimEnd());
    }
  }
  throw new Error(reason);
}

function main(): number {
  const first = runTsc();
  if (first.exitCode === 0) {
    console.log("nothing to graduate");
    return 0;
  }
  const { diagnostics, unparsed } = parseDiagnostics(first.stdout);
  if (unparsed.length > 0) {
    abort(
      "the compiler produced output this script cannot parse as diagnostics; refusing to touch anything",
      first.stdout,
      first.stderr,
    );
  }
  const plan = planGraduation(diagnostics);
  if (plan.foreign.length > 0) {
    abort(
      `${plan.foreign.length} diagnostic(s) are not gap-file tripwires (TS2344 inside ${GAPS_DIR}/); something else is broken, fix it first`,
      first.stdout,
      first.stderr,
    );
  }
  if (plan.gapFiles.length === 0) {
    abort(
      "the compiler failed but printed no diagnostics; refusing to touch anything",
      first.stdout,
      first.stderr,
    );
  }
  const indexAbs = join(ROOT, INDEX_PATH);
  // All-or-nothing: a spec-pinned gap in the set means tsc cannot go green
  // by deleting only the others, so the whole run stops for a human.
  const specPinned = plan.gapFiles.filter((gapFile) =>
    isSpecPinned(readFileSync(join(ROOT, gapFile), "utf8")),
  );
  if (specPinned.length > 0) {
    abort(
      `octokit shipped routes of ${specPinned.join(", ")}, but the gap is marked documentedInSpec: false ` +
        `(the pinned OpenAPI descriptor lacks its paths). Bump UPSTREAM_REF in .github/scripts/trim-openapi.ts, ` +
        `flip documentedInSpec to true, regenerate the trimmed spec, then delete the gap file (or re-run this script)`,
      first.stdout,
      first.stderr,
    );
  }
  let index = readFileSync(indexAbs, "utf8");
  for (const gapFile of plan.gapFiles) {
    index = removeGapFromIndex(index, gapFile);
  }
  writeFileSync(indexAbs, index);
  for (const gapFile of plan.gapFiles) {
    unlinkSync(join(ROOT, gapFile));
  }
  const second = runTsc();
  if (second.exitCode !== 0) {
    abort(
      `deleting ${plan.gapFiles.join(", ")} did not turn the build green - likely a partial graduation ` +
        `(a section still calls a route the file also declared). Split the gap file by hand; ` +
        `\`git checkout -- ${GAPS_DIR}\` restores the tree`,
      second.stdout,
      second.stderr,
    );
  }
  console.log(`graduated:\n  ${plan.gapFiles.join("\n  ")}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
