/**
 * Graduates upstream-gap files whose routes @octokit/types now ships: each defineGap file's tripwire type turns
 * `tsc` red with TS2344 inside that file, and this script turns the build green again. TypeScript 7.0.2 ships its
 * in-process API only under `typescript/unstable/`, so the CLI's diagnostic lines are read until it leaves there.
 *
 *   documentedInSpec: true                              -> the file is deleted
 *   documentedInSpec: false                             -> rewritten to defineSpecOnlyGap (no tripwire; the UNDOCUMENTED_ROUTES exemption stays)
 *   a diagnostic that is not a TS2344 inside a gap file -> abort untouched; a half-fix would bury whatever else broke
 *   the re-compile still red                            -> abort for a human; a partially shipped file must be split by hand
 *
 * Run: `bun .github/scripts/graduate-upstream-gaps.ts`; `git checkout -- src/upstream-gaps src/generated/upstream-gaps.ts` restores the tree.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Node, type ObjectExpression, parseSync } from "oxc-parser";
import { countNoun } from "../../src/text.js";
import { INDEX_PATH, isGapFileName, regenerateIndex } from "./gen-gaps-index.js";
import { formatted } from "./lib/biome-format.js";
import { runMain } from "./lib/entry.js";
import { type Diagnostic, parseDiagnostics } from "./lib/tsc-diagnostics.js";

const ROOT = join(import.meta.dir, "..", "..");
const GAPS_DIR = "src/upstream-gaps";

export interface GraduationPlan {
  /** Gap-file paths (repo-relative, deduplicated, sorted) with a TS2344. */
  gapFiles: string[];

  /** Diagnostics the script must not fix: wrong code, or outside a gap file. */
  foreign: Diagnostic[];
}

export function isGapFile(file: string): boolean {
  if (!file.startsWith(`${GAPS_DIR}/`)) {
    return false;
  }
  const rest = file.slice(`${GAPS_DIR}/`.length);
  return !rest.includes("/") && isGapFileName(rest);
}

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

interface GapExport {
  /** The helper `export const GAP = <helper>({...})` calls. */
  helper: string;

  /** The properties of the object literal the helper is called with, by key. */
  properties: ReadonlyMap<string, Node>;

  /** Whether every property is a plain `key: value`; a spread or a computed key could override what `properties` holds. */
  plain: boolean;

  /** The block comment directly above the export, its delimiters stripped. */
  doc: string | undefined;

  /** The source text of each comment inside `node`: a rewrite that keeps only the node's values would drop it. */
  commentsIn(node: Node): string[];
}

/** The helper and the object literal of `export const GAP = helper({...})`, or undefined for any other statement. */
function gapCall(statement: Node): { helper: string; argument: ObjectExpression } | undefined {
  if (
    statement.type !== "ExportNamedDeclaration" ||
    statement.declaration?.type !== "VariableDeclaration"
  ) {
    return undefined;
  }
  const declarator = statement.declaration.declarations[0];
  const call = declarator?.init;
  if (
    declarator?.id.type !== "Identifier" ||
    declarator.id.name !== "GAP" ||
    call?.type !== "CallExpression" ||
    call.callee.type !== "Identifier"
  ) {
    return undefined;
  }
  const argument = call.arguments[0];
  return argument?.type === "ObjectExpression" ? { helper: call.callee.name, argument } : undefined;
}

/** The file's `export const GAP = helper({...})`, read from the syntax tree; a comment or a string that quotes a
 * helper or a property never decides. Undefined when the file does not parse or has no such export. */
function readGapExport(source: string): GapExport | undefined {
  const { program, errors, comments } = parseSync("gap.ts", source);
  if (errors.length > 0) {
    return undefined;
  }
  for (const statement of program.body) {
    const call = gapCall(statement);
    if (call === undefined) {
      continue;
    }
    const properties = new Map<string, Node>();
    let plain = true;
    for (const property of call.argument.properties) {
      if (
        property.type === "Property" &&
        property.key.type === "Identifier" &&
        !property.computed
      ) {
        properties.set(property.key.name, property.value);
      } else {
        plain = false;
      }
    }
    const above = comments.findLast((comment) => comment.end <= statement.start);
    const isDoc = above?.type === "Block" && source.slice(above.end, statement.start).trim() === "";
    return {
      helper: call.helper,
      properties,
      plain,
      doc: isDoc ? above.value : undefined,
      commentsIn: (node) =>
        comments
          .filter((comment) => comment.start >= node.start && comment.end <= node.end)
          .map((comment) => source.slice(comment.start, comment.end)),
    };
  }
  return undefined;
}

/** What the graduation does with a flagged gap file: delete it, rewrite it to spec-only, or refuse with a reason. */
export type Graduation = "delete" | "rewrite" | { refusal: string };

/** `documentedInSpec: true` deletes. `false` means octokit caught up but the pinned descriptor did not: the file is
 * rewritten, so its UNDOCUMENTED_ROUTES exemption survives until an @octokit/openapi bump documents the paths.
 * Anything this script cannot read as one of the two is refused: a guess would delete a file on a value nobody read. */
export function graduationOf(gapSource: string): Graduation {
  const gap = readGapExport(gapSource);
  if (gap?.helper === "defineSpecOnlyGap") {
    // A spec-only gap carries no octokit tripwire, so a diagnostic inside one is not a graduation; deleting it
    // would silently drop its UNDOCUMENTED_ROUTES exemption.
    return {
      refusal:
        "is a spec-only gap but the compiler flagged it; that is not a graduation - fix the file by hand",
    };
  }
  const flag =
    gap?.helper === "defineGap" && gap.plain ? gap.properties.get("documentedInSpec") : undefined;
  if (flag?.type !== "Literal" || typeof flag.value !== "boolean") {
    return {
      refusal:
        "does not declare documentedInSpec as a plain true or false in defineGap({...}); graduate the file by hand",
    };
  }
  return flag.value ? "delete" : "rewrite";
}

/** A spec-only gap source: octokit ships its routes already, so it carries no tripwire. */
export function isSpecOnly(gapSource: string): boolean {
  return readGapExport(gapSource)?.helper === "defineSpecOnlyGap";
}

/** A gap source the graduation rewrites instead of deleting. */
export function isSpecPinned(gapSource: string): boolean {
  return graduationOf(gapSource) === "rewrite";
}

/** Only the feature clause survives (the text up to the first ";", where the octokit-lags prose starts): preserving
 * the whole original would keep a now-false "octokit does not carry these routes yet" sentence in a bot-committed file. */
function specOnlyDoc(doc: string): string {
  const text = doc
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, ""))
    .join(" ")
    .trim();
  const head = (text.split(";")[0] ?? text).replace(/\.\s*$/, "").trim();
  return `/** ${head}; @octokit/types ships these routes, but the pinned OpenAPI descriptor does not document them yet. */`;
}

export function toSpecOnlyGapSource(source: string, gapFile: string): string {
  const gap = readGapExport(source);
  if (gap?.helper !== "defineGap" || gap.doc === undefined) {
    throw new Error(
      `${gapFile} does not match the documented defineGap shape (doc comment + export const GAP = defineGap({...})); rewrite it to defineSpecOnlyGap by hand`,
    );
  }
  const array = gap.properties.get("routes");
  const elements = array?.type === "ArrayExpression" ? array.elements : [];
  if (elements.length === 0) {
    throw new Error(
      `${gapFile} declares no parsable routes; rewrite it to defineSpecOnlyGap by hand`,
    );
  }
  // Anything besides plain string literals (an identifier, a spread, a template literal, a comment) would be
  // dropped by the rewrite: refuse instead of silently losing it.
  const routes: string[] = [];
  const leftover = array === undefined ? [] : gap.commentsIn(array);
  for (const element of elements) {
    if (element?.type === "Literal" && typeof element.value === "string") {
      routes.push(element.value);
    } else {
      leftover.push(element === null ? "an empty slot" : source.slice(element.start, element.end));
    }
  }
  if (leftover.length > 0) {
    throw new Error(
      `${gapFile}'s routes array holds more than plain string literals (leftover: ${leftover.join(" ")}); rewrite it to defineSpecOnlyGap by hand`,
    );
  }
  const rewritten = [
    // check-file-headers.ts gates the rewritten file too; this header is true of every spec-only gap, whatever its routes.
    "/** A spec-only gap: its routes are exempt from the e2e validator's unknown-route check until the pinned OpenAPI descriptor documents them; the file is then deleted by hand (./gap.ts). */",
    "",
    `import { defineSpecOnlyGap } from "./gap.js";`,
    "",
    specOnlyDoc(gap.doc),
    "export const GAP = defineSpecOnlyGap({",
    `  routes: [${routes.map((route) => JSON.stringify(route)).join(", ")}],`,
    "});",
    "",
  ].join("\n");
  return formatted(gapFile, rewritten);
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
      `${countNoun(plan.foreign.length, "diagnostic", "diagnostics")} outside the gap-file tripwires (TS2344 inside ${GAPS_DIR}/); something else is broken, fix it first`,
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
  // Classify and render everything BEFORE touching the disk, so an unparsable spec-pinned file aborts with the tree untouched.
  const deletions: string[] = [];
  const rewrites: { gapFile: string; next: string }[] = [];
  for (const gapFile of plan.gapFiles) {
    const source = readFileSync(join(ROOT, gapFile), "utf8");
    const graduation = graduationOf(source);
    if (graduation === "delete") {
      deletions.push(gapFile);
    } else if (graduation === "rewrite") {
      rewrites.push({ gapFile, next: toSpecOnlyGapSource(source, gapFile) });
    } else {
      abort(`${gapFile} ${graduation.refusal}`, first.stdout, first.stderr);
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
        `\`git checkout -- ${GAPS_DIR} ${INDEX_PATH}\` restores the tree`,
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
  await runMain("graduate-upstream-gaps", main);
}
