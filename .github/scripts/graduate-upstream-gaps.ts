/**
 * Graduate upstream-gap files whose routes @octokit/types now ships. Each
 * defineGap file under src/upstream-gaps/ carries a tripwire type that makes
 * `bun x tsc -p . --noEmit` fail with TS2344 inside that file the moment
 * upstream types one of its routes. This script turns that red build back
 * green, per the file's lifecycle: a documentedInSpec: true gap is deleted
 * outright, and a documentedInSpec: false gap (the pinned OpenAPI descriptor
 * also lags its routes) is rewritten to the spec-only lifecycle
 * (defineSpecOnlyGap: no tripwire, UNDOCUMENTED_ROUTES exemption kept). The
 * gaps index is then regenerated wholesale via gen-gaps-index.ts.
 *
 * Run: `bun .github/scripts/graduate-upstream-gaps.ts` (from anywhere; it
 * compiles the repo root). A clean compile means nothing to graduate. Any
 * diagnostic that is not a TS2344 inside a gap file aborts the run untouched:
 * something else is broken, and a half-fix would bury it. A re-compile after
 * the deletions and rewrites must be green, or the run aborts for a human (a
 * gap file whose routes shipped only partially must be split by hand;
 * `git checkout -- src/upstream-gaps` restores the tree).
 *
 * TypeScript 7 (tsgo) has no in-process compiler API, so the CLI plus
 * diagnostic-line parsing IS the design, not a stopgap.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isGapFileName, regenerateIndex } from "./gen-gaps-index.js";

const ROOT = join(import.meta.dir, "..", "..");
const GAPS_DIR = "src/upstream-gaps";

/** One parsed `file(line,col): error TSnnnn: message` compiler line. */
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
}

/** What the diagnostics demand: the gap files to graduate, and everything else. */
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
 * True for a path this script may graduate: a gap file directly under
 * src/upstream-gaps/ (per the generator's shared name predicate). A TS2344
 * anywhere else is foreign.
 */
export function isGapFile(file: string): boolean {
  if (!file.startsWith(`${GAPS_DIR}/`)) {
    return false;
  }
  const rest = file.slice(`${GAPS_DIR}/`.length);
  return !rest.includes("/") && isGapFileName(rest);
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

/**
 * True for a gap whose routes the published OpenAPI description does not
 * document yet (documentedInSpec: false). Its tripwire firing means octokit
 * caught up but the descriptor did not: the file is rewritten to the
 * spec-only lifecycle instead of deleted, so its UNDOCUMENTED_ROUTES
 * exemption survives until a bumped UPSTREAM_REF documents the paths.
 */
export function isSpecPinned(gapSource: string): boolean {
  return /documentedInSpec:\s*false/.test(gapSource);
}

/** `  routes: [...],` in the shape biome would format: inline while it fits. */
function renderRoutes(routes: readonly string[]): string {
  const inline = `  routes: [${routes.map((route) => `"${route}"`).join(", ")}],`;
  if (inline.length <= 100) {
    return inline;
  }
  return ["  routes: [", ...routes.map((route) => `    "${route}",`), "  ],"].join("\n");
}

/**
 * The rewritten GAP doc: the original comment's feature clause (its text up
 * to the first ";", which is where the octokit-lags prose starts), plus a
 * generated clause describing the spec-only state. Preserving the whole
 * original would keep a now-false "octokit does not carry these routes yet"
 * sentence in a bot-committed file.
 */
function specOnlyDoc(doc: string): string {
  const text = doc
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, ""))
    .join(" ")
    .trim();
  const head = (text.split(";")[0] ?? text).replace(/\.\s*$/, "").trim();
  return `/** ${head}; @octokit/types ships these routes, but the pinned OpenAPI descriptor does not document them yet. */`;
}

/**
 * Rewrite a tripped documentedInSpec: false gap file to the spec-only
 * lifecycle: keep its GAP doc's feature clause and its routes, emit the
 * defineSpecOnlyGap template around them (no tripwire, no flag).
 * Deterministic generation from those two extracted parts - never line
 * surgery on the old source. Throws on a source that does not match the
 * defineGap shape.
 */
export function toSpecOnlyGapSource(source: string, gapFile: string): string {
  // (?:[^*]|\*(?!\/))* spans exactly one block comment (no */ inside), so a
  // module-head comment earlier in the file can never be mistaken for the
  // GAP doc: only the comment directly above the export matches.
  const match =
    /(?<doc>\/\*\*(?:[^*]|\*(?!\/))*\*\/)\s*\nexport const GAP = defineGap\(\{(?<body>[\s\S]*?)\}\);/.exec(
      source,
    );
  const body = match?.groups?.body;
  const doc = match?.groups?.doc;
  if (body === undefined || doc === undefined) {
    throw new Error(
      `${gapFile} does not match the documented defineGap shape (doc comment + export const GAP = defineGap({...})); rewrite it to defineSpecOnlyGap by hand`,
    );
  }
  const routesMatch = /routes:\s*\[(?<routes>[\s\S]*?)\]/.exec(body);
  const routesBody = routesMatch?.groups?.routes ?? "";
  const routes = [...routesBody.matchAll(/"([^"]+)"/g)].map((hit) => hit[1] as string);
  if (routes.length === 0) {
    throw new Error(
      `${gapFile} declares no parsable routes; rewrite it to defineSpecOnlyGap by hand`,
    );
  }
  // Anything in the array besides plain string literals (an identifier, a
  // comment, a template literal) would be dropped by the rewrite: refuse
  // instead of silently losing it.
  const leftover = routesBody.replace(/"[^"]+"/g, "").replace(/[,\s]/g, "");
  if (leftover !== "") {
    throw new Error(
      `${gapFile}'s routes array holds more than plain string literals (leftover: ${leftover}); rewrite it to defineSpecOnlyGap by hand`,
    );
  }
  return [
    `import { defineSpecOnlyGap } from "./gap.js";`,
    "",
    specOnlyDoc(doc),
    "export const GAP = defineSpecOnlyGap({",
    renderRoutes(routes),
    "});",
    "",
  ].join("\n");
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
  // Classify and render everything BEFORE touching the disk, so an
  // unparsable spec-pinned file aborts with the tree untouched.
  const deletions: string[] = [];
  const rewrites: { gapFile: string; next: string }[] = [];
  for (const gapFile of plan.gapFiles) {
    const source = readFileSync(join(ROOT, gapFile), "utf8");
    if (isSpecPinned(source)) {
      rewrites.push({ gapFile, next: toSpecOnlyGapSource(source, gapFile) });
    } else {
      deletions.push(gapFile);
    }
  }
  for (const { gapFile, next } of rewrites) {
    writeFileSync(join(ROOT, gapFile), next);
  }
  for (const gapFile of deletions) {
    unlinkSync(join(ROOT, gapFile));
  }
  regenerateIndex();
  const second = runTsc();
  if (second.exitCode !== 0) {
    abort(
      `graduating ${plan.gapFiles.join(", ")} did not turn the build green - likely a partial graduation ` +
        `(octokit shipped only some of a file's routes). Split the gap file by hand; ` +
        `\`git checkout -- ${GAPS_DIR}\` restores the tree`,
      second.stdout,
      second.stderr,
    );
  }
  if (deletions.length > 0) {
    console.log(`graduated:\n  ${deletions.join("\n  ")}`);
  }
  if (rewrites.length > 0) {
    console.log(
      `rewritten to spec-only (octokit shipped the routes; the pinned OpenAPI descriptor still lags):\n  ${rewrites.map(({ gapFile }) => gapFile).join("\n  ")}`,
    );
  }
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
