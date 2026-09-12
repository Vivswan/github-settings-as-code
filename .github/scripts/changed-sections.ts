/**
 * The diff-aware section selector for the PR e2e smoke job: a PR touching one section runs that section's scenarios
 * and fuzz rather than the whole corpus, and a PR touching nothing settings-related skips the smoke steps. A
 * src/sections/ path no rule recognizes throws, so a new file cannot silently skip them.
 *
 *   src/sections/<key>/...                                   -> <key>, whatever the file
 *   src/sections/shared/<file>.ts                            -> the sections that transitively import it (deriveSharedFanOut)
 *   contract/, registry.ts, the engine, the schema, the e2e harness  -> every section
 *
 * CLI: `bun .github/scripts/changed-sections.ts [base-ref]` (default origin/main) prints a comma-separated section
 * list, `all`, or `none`; the smoke steps run unless the output is `none`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type Node, parseSync } from "oxc-parser";
import { SECTION_KEYS, type SectionKey } from "../../src/schema.js";

/** The sentinel the CLI prints (and the job branches on) when every section is in play. */
export const ALL = "all";
/** The sentinel printed when nothing settings-related changed. */
export const NONE = "none";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** registry.ts wires every handler, so it selects EVERY section. docs-registry.ts never reaches the bundle and its
 * drift is gated by build:check, so it selects NONE (the same reasoning keeps lib/ out of ALL_SELECTING_PREFIXES). */
const ALL_SELECTING_SECTION_FILES = new Set(["registry.ts"]);
const NONE_SELECTING_SECTION_FILES = new Set(["docs-registry.ts"]);

const SECTION_KEY_SET: ReadonlySet<string> = new Set(SECTION_KEYS);

/** `lib/` is deliberately NOT here: its only committed file is the generated settings.schema.json, which mirrors a
 * `src/schema.ts` change and is gated by the schema-check job on its own. test/scripts/changed-sections.test.ts
 * checks that every top-level `src/` entry other than `sections/` is listed, so a new module cannot be silently skipped. */
export const ALL_SELECTING_PREFIXES = [
  // Every section is written against the contract's layered modules, so a change there selects everything.
  "src/sections/contract/",
  "src/engine/",
  "src/flows/",
  "src/github/",
  "src/action/",
  // The CLI runs the same flows the action does, so its change is smoked like the action's.
  "src/cli/",
  "src/cli.ts",
  "src/discovery/",
  "src/report/",
  // Cross-cutting: gap files define supplemental route typing across sections.
  "src/upstream-gaps/",
  "src/index.ts",
  "src/io.ts",
  "src/main.ts",
  "src/plain-data.ts",
  "src/private-open.ts",
  "src/private.ts",
  "src/problem.ts",
  "src/schema.ts",
  "src/types.ts",
  "test/e2e/",
  // The selection machinery itself: a PR touching only these must not select "none" and skip the very job they configure.
  ".github/scripts/",
  ".github/workflows/checks.yml",
  ".github/actions/",
];

export type Selection =
  | { kind: "all" }
  | { kind: "some"; sections: SectionKey[] }
  | { kind: "none" };

/** A deleted file has no code left to smoke. */
export interface ChangedFile {
  path: string;
  deleted: boolean;
}

/** bun's own TypeScript parser, so comments, strings, and templates never read as imports. */
const TRANSPILER = new Bun.Transpiler({ loader: "ts" });

function isLiteralSpecifier(node: Node | undefined): boolean {
  return (
    (node?.type === "Literal" && typeof node.value === "string") ||
    (node?.type === "TemplateLiteral" && node.expressions.length === 0)
  );
}

function isComputedModuleLoad(node: Node): boolean {
  if (node.type === "ImportExpression") {
    return !isLiteralSpecifier(node.source);
  }
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    !isLiteralSpecifier(node.arguments[0])
  );
}

function* nodesOf(value: unknown): Generator<Node> {
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* nodesOf(item);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if ("type" in value && typeof value.type === "string") {
    yield value as Node;
  }
  for (const child of Object.values(value)) {
    yield* nodesOf(child);
  }
}

/** A computed specifier is an edge the graph cannot read, and a missing edge can under-select, the one failure this
 * selector exists to prevent: the file is rewritten, not skipped. */
function assertNoComputedImports(text: string, file: string): void {
  // Bun's import list silently omits a computed import()/require(), so oxc walks the AST only to find those.
  const { program, errors } = parseSync(file, text);
  const lineOf = (offset: number): number => text.slice(0, offset).split("\n").length;
  const [error] = errors;
  if (error) {
    throw new Error(
      `${file}:${lineOf(error.labels[0]?.start ?? 0)} does not parse: ${error.message}`,
    );
  }
  for (const node of nodesOf(program)) {
    if (isComputedModuleLoad(node)) {
      throw new Error(
        `${file}:${lineOf(node.start)} loads a module through a computed specifier, which the import graph cannot follow - use a string literal`,
      );
    }
  }
}

/** Type-only imports are erased from the bundle, so they are not edges here (arch-lint.ts adds them itself). The
 * errors name the file, not this tool, because arch-lint.ts shares this and resolveImport. */
export function scanImports(text: string, file: string): string[] {
  assertNoComputedImports(text, file);
  // Bun.Transpiler rejects a shebang line (the bin entry keeps one); oxc above accepts it.
  return TRANSPILER.scanImports(text.replace(/^#!.*\n/, ""))
    .map((entry) => entry.path)
    .filter((specifier) => specifier.startsWith("./") || specifier.startsWith("../"));
}

/** Source spells the emitted `.js`, hence the `.ts` and `/index.ts` candidates. Nothing found throws: a dangling
 * specifier would silently drop an edge. */
export function resolveImport(importer: string, specifier: string): string {
  const target = resolve(dirname(importer), specifier);
  const candidates = specifier.endsWith(".json")
    ? [target]
    : [`${target.replace(/\.[jt]s$/, "")}.ts`, join(target.replace(/\.[jt]s$/, ""), "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `${importer} imports "${specifier}", which resolves to no file (tried ${candidates.join(" and ")})`,
  );
}

/** Unit tests are not smoke inputs, and the section tests that import the engine would pull the registry, and
 * through it every section, into every shared file's fan-out. */
export function sourceFilesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .map((entry) => join(root, entry));
}

export function reverseImportGraph(files: readonly string[]): Map<string, Set<string>> {
  const importedBy = new Map<string, Set<string>>();
  for (const file of files) {
    for (const specifier of scanImports(readFileSync(file, "utf8"), file)) {
      const target = resolveImport(file, specifier);
      const importers = importedBy.get(target) ?? new Set<string>();
      importers.add(file);
      importedBy.set(target, importers);
    }
  }
  return importedBy;
}

export function transitiveDependents(
  importedBy: ReadonlyMap<string, ReadonlySet<string>>,
  file: string,
): Set<string> {
  const seen = new Set<string>();
  const pending = [file];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const importer of importedBy.get(next) ?? []) {
      if (!seen.has(importer)) {
        seen.add(importer);
        pending.push(importer);
      }
    }
  }
  return seen;
}

/** A dependent outside a section directory adds no key: an all-selecting path selects everything on its own, and a
 * shared/ dependent has a fan-out of its own. A shared file with no section dependent is dead code or a scan gap, and
 * neither may quietly select nothing. */
export function deriveSharedFanOut(repoRoot: string): Record<string, SectionKey[]> {
  const sectionsDir = join(repoRoot, "src", "sections");
  const sharedDir = join(sectionsDir, "shared");
  const importedBy = reverseImportGraph(sourceFilesUnder(join(repoRoot, "src")));
  const fanOut: Record<string, SectionKey[]> = {};
  for (const shared of sourceFilesUnder(sharedDir)) {
    const keys = new Set<string>();
    for (const dependent of transitiveDependents(importedBy, shared)) {
      const [dir] = relative(sectionsDir, dependent).split("/");
      if (dir !== undefined && SECTION_KEY_SET.has(dir)) {
        keys.add(dir);
      }
    }
    const sharedPath = relative(sharedDir, shared);
    if (keys.size === 0) {
      throw new Error(
        `changed-sections: no section imports src/sections/shared/${sharedPath}, so no smoke selection covers it - delete the dead file, or fix the import scan if a section does import it`,
      );
    }
    fanOut[sharedPath] = SECTION_KEYS.filter((key) => keys.has(key));
  }
  return fanOut;
}

export type SharedFanOut = Record<string, SectionKey[]>;

let realFanOut: SharedFanOut | undefined;

function realSharedFanOut(): SharedFanOut {
  realFanOut ??= deriveSharedFanOut(REPO_ROOT);
  return realFanOut;
}

/** `foo.ts` and `foo/index.ts` are interchangeable to every importer of `./foo.js`. */
function siblingResolution(sharedPath: string): string {
  return sharedPath.endsWith("/index.ts")
    ? `${sharedPath.slice(0, -"/index.ts".length)}.ts`
    : `${sharedPath.slice(0, -".ts".length)}/index.ts`;
}

/** Below the ALL_SELECTING_PREFIXES check, so src/sections/contract/ never reaches here. Anything unrecognized
 * throws: a silently ignored section path would let a PR skip the very scenarios its change needs. */
function sectionsForSectionsPath(
  { path, deleted }: ChangedFile,
  sharedFanOut: () => SharedFanOut,
): SectionKey[] | "all" {
  const rest = path.slice("src/sections/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) {
    if (ALL_SELECTING_SECTION_FILES.has(rest)) {
      return "all";
    }
    if (NONE_SELECTING_SECTION_FILES.has(rest)) {
      return [];
    }
    throw new Error(
      `changed-sections: ${path} matches no selector rule; src/sections/ holds only the flat ` +
        `files in ALL_SELECTING_SECTION_FILES and NONE_SELECTING_SECTION_FILES, the per-section ` +
        `<key>/ directories, contract/, and shared/ - move the file under its section directory`,
    );
  }
  const dir = rest.slice(0, slash);
  if (SECTION_KEY_SET.has(dir)) {
    return [dir as SectionKey];
  }
  if (dir === "shared") {
    const sharedPath = rest.slice(slash + 1);
    if (sharedPath.endsWith(".docs.yml")) {
      // The factories' schema prose never reaches the bundle; build:check gates it, as with the docs registry.
      return [];
    }
    if (deleted && sharedPath.endsWith(".ts")) {
      // Its importers either changed in the same diff (typecheck fails otherwise) and select their sections, or
      // now resolve to the sibling spelling, whose fan-out is then theirs.
      return sharedFanOut()[siblingResolution(sharedPath)] ?? [];
    }
    const keys = sharedFanOut()[sharedPath];
    if (keys) {
      return keys;
    }
    throw new Error(
      `changed-sections: ${path} matches no selector rule; under src/sections/shared/ only .ts files (fanning out through the import graph) and the .docs.yml prose are recognized`,
    );
  }
  throw new Error(
    `changed-sections: ${path} matches no selector rule; a section directory must spell its SectionKey verbatim (or add the directory to ALL_SELECTING_PREFIXES if it is cross-cutting)`,
  );
}

/** Every src/sections/ path is resolved even when a cross-cutting path already forces "all", so a stale flat path
 * cannot ride along unnoticed. */
export function sectionsForFiles(
  files: readonly ChangedFile[],
  sharedFanOut: () => SharedFanOut = realSharedFanOut,
): Selection {
  const selected = new Set<SectionKey>();
  let all = false;
  for (const file of files) {
    if (ALL_SELECTING_PREFIXES.some((prefix) => file.path.startsWith(prefix))) {
      all = true;
      continue;
    }
    if (!file.path.startsWith("src/sections/")) {
      continue;
    }
    if (sectionsForSectionsPath(file, sharedFanOut) === "all") {
      all = true;
    }
  }
  if (all) {
    return { kind: "all" };
  }
  for (const file of files) {
    if (!file.path.startsWith("src/sections/")) {
      continue;
    }
    const keys = sectionsForSectionsPath(file, sharedFanOut);
    if (keys !== "all") {
      for (const key of keys) {
        selected.add(key);
      }
    }
  }
  if (selected.size === 0) {
    return { kind: "none" };
  }
  // SECTION_KEYS order, so the printed list is stable.
  return { kind: "some", sections: SECTION_KEYS.filter((key) => selected.has(key)) };
}

export function renderSelection(selection: Selection): string {
  if (selection.kind === "all") {
    return ALL;
  }
  if (selection.kind === "none") {
    return NONE;
  }
  return selection.sections.join(",");
}

/** Exactly the statuses `git diff --name-status --no-renames` can emit; a scored R/C or a letter git does not use is
 * a shape this parser refuses. */
const GIT_STATUS = /^[ADMTUXB]$/;

/** `-z` keeps paths raw (git would otherwise C-quote unicode, tabs, and newlines, hiding a src/sections/ prefix), and
 * `--no-renames` keeps every record single-path (a rename is a D plus an A). Any other shape throws, never skipped. */
export function parseNameStatus(out: string): ChangedFile[] {
  if (out !== "" && !out.endsWith("\0")) {
    throw new Error(
      `changed-sections: git name-status output is not NUL-terminated: ${JSON.stringify(out.slice(-40))}`,
    );
  }
  const fields = out.split("\0");
  fields.pop();
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i] ?? "";
    const path = fields[i + 1];
    if (!GIT_STATUS.test(status) || path === undefined || path === "") {
      throw new Error(
        `changed-sections: unparseable git name-status record ${JSON.stringify(fields.slice(i, i + 2))}`,
      );
    }
    files.push({ path, deleted: status === "D" });
  }
  return files;
}

export function changedFiles(baseRef: string): ChangedFile[] {
  return parseNameStatus(
    execFileSync("git", ["diff", "--name-status", "--no-renames", "-z", `${baseRef}...HEAD`], {
      encoding: "utf8",
    }),
  );
}

if (import.meta.main) {
  const baseRef = process.argv[2] ?? "origin/main";
  const selection = sectionsForFiles(changedFiles(baseRef));
  console.log(renderSelection(selection));
}
