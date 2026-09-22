/**
 * The architecture lint (bun run lint:arch): src/ imports between layers must be exactly the edges architecture.yml
 * declares; an undeclared edge and a stale allowance both fail. dependency-cruiser was the intended tool, but it
 * needs the TypeScript compiler API, which the pinned typescript 7 no longer ships, so it resolves nothing here.
 *   runtime loads: imports, re-exports, literal `import()` and `require()`   -> edges
 *   type-only imports and re-exports                                         -> edges too
 *   `import("./x.js").T`, `import X = require("./x.js")` in type positions   -> edges too
 *   a computed `import(x)` or `require(x)`                                   -> fails: the graph cannot follow it
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { inspect } from "node:util";
import { err, ok, Result } from "neverthrow";
import { type Node, parseSync } from "oxc-parser";
import { parseDocument } from "yaml";
import { z } from "zod";
import { countNoun } from "../../src/text.js";

export const ARCHITECTURE_PATH = "architecture.yml";

export interface Architecture {
  /** layer -> the src/ paths it owns (a `/` suffix means a directory). */
  readonly layers: Readonly<Record<string, readonly string[]>>;
  readonly exclude: readonly string[];
  /** from -> the layers it may import. */
  readonly edges: Readonly<Record<string, readonly string[]>>;
}

const PATHS = z.array(z.string());
const ARCHITECTURE = z.strictObject({
  layers: z.record(z.string(), PATHS),
  exclude: PATHS,
  edges: z.record(z.string(), PATHS),
}) satisfies z.ZodType<Architecture>;

/** `layers.engine[0]`, `edges["plain-data"]`: the yaml key as a reader would write it in code. */
function keyPath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) =>
      typeof segment === "number"
        ? `[${segment}]`
        : /^[A-Za-z_]\w*$/.test(String(segment))
          ? `${index === 0 ? "" : "."}${String(segment)}`
          : `[${JSON.stringify(String(segment))}]`,
    )
    .join("");
}

function describeIssue(doc: unknown, issue: z.core.$ZodIssue): string[] {
  const key = keyPath(issue.path);
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((unknown) => `unknown key ${keyPath([...issue.path, unknown])}`);
  }
  const value = issue.path.reduce<unknown>(
    (parent, segment) =>
      typeof parent === "object" && parent !== null
        ? (parent as Record<PropertyKey, unknown>)[segment]
        : undefined,
    doc,
  );
  if (value === undefined) {
    return [`${key} is missing`];
  }
  return [
    `${key} is ${inspect(value, { breakLength: Number.POSITIVE_INFINITY })}; ${issue.message}`,
  ];
}

export function parseArchitecture(root: string): Result<Architecture, string[]> {
  const document = parseDocument(readFileSync(join(root, ARCHITECTURE_PATH), "utf8"));
  if (document.errors.length > 0) {
    // The first line of a yaml error is the sentence with its line and column; the rest is a code frame.
    return err(
      located(document.errors.map((error) => error.message.split(":\n")[0] ?? error.code)),
    );
  }
  const doc = Result.fromThrowable(
    (): unknown => document.toJS(),
    (error) => located([error instanceof Error ? error.message : String(error)]),
  )();
  if (doc.isErr()) {
    return err(doc.error);
  }
  const parsed = ARCHITECTURE.safeParse(doc.value);
  return parsed.success
    ? ok(parsed.data)
    : err(located(parsed.error.issues.flatMap((issue) => describeIssue(doc.value, issue))));
}

function located(problems: readonly string[]): string[] {
  return problems.map((problem) => `${ARCHITECTURE_PATH}: ${problem}`);
}

/** For callers that render rather than lint (docs, tests): a malformed declaration is fatal to them. */
export function readArchitecture(root: string): Architecture {
  return parseArchitecture(root).match(
    (arch) => arch,
    (problems) => {
      throw new Error(problems.join("\n"));
    },
  );
}

function layerOf(arch: Architecture, path: string): string | undefined {
  return Object.entries(arch.layers).find(([, paths]) =>
    paths.some((owned) => (owned.endsWith("/") ? path.startsWith(owned) : path === owned)),
  )?.[0];
}

function* nodesOf(value: unknown): Generator<Node> {
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* nodesOf(item);
    }
  } else if (typeof value === "object" && value !== null) {
    if ("type" in value && typeof value.type === "string") {
      yield value as Node;
    }
    for (const child of Object.values(value)) {
      yield* nodesOf(child);
    }
  }
}

/** The expression under the wrappers parentheses and TypeScript add: `(require)(x)`, `require!(x)`,
 * `(require as any)(x)`, `require<T>(x)`. */
function unwrapped(expression: Node): Node {
  switch (expression.type) {
    case "ParenthesizedExpression":
    case "TSNonNullExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "TSInstantiationExpression":
      return unwrapped(expression.expression);
    default:
      return expression;
  }
}

/** Whether the node loads a module: a static import or re-export, `import()`, `require()`, `import("./x.js").T`,
 * or `import X = require("./x.js")`. */
function isModuleLoad(node: Node): boolean {
  switch (node.type) {
    case "ImportDeclaration":
    case "ExportAllDeclaration":
    case "ImportExpression":
    case "TSImportType":
    case "TSExternalModuleReference":
      return true;
    case "ExportNamedDeclaration":
      return node.source !== null;
    case "CallExpression": {
      const callee = unwrapped(node.callee);
      return callee.type === "Identifier" && callee.name === "require";
    }
    default:
      return false;
  }
}

/** The module a load names, or undefined when the specifier is computed (`import(x)`, `require(x)`, a template
 * with expressions), which the graph cannot follow. */
function literalModuleRequest(node: Node): string | undefined {
  const raw =
    node.type === "TSExternalModuleReference"
      ? node.expression
      : node.type === "CallExpression"
        ? node.arguments[0]
        : "source" in node
          ? node.source
          : undefined;
  const request = raw === undefined || raw === null ? undefined : unwrapped(raw);
  if (request?.type === "Literal" && typeof request.value === "string") {
    return request.value;
  }
  if (request?.type === "TemplateLiteral" && request.expressions.length === 0) {
    return request.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** Every relative specifier `text` loads, each once. A file that does not parse or loads a module through a
 * computed specifier throws naming the line: a dropped edge would let a forbidden import pass. */
export function importSpecifiers(text: string, file: string): string[] {
  const { program, errors } = parseSync(file, text);
  const lineOf = (offset: number): number => text.slice(0, offset).split("\n").length;
  const [error] = errors;
  if (error) {
    throw new Error(
      `${file}:${lineOf(error.labels[0]?.start ?? 0)} does not parse: ${error.message}`,
    );
  }
  const specifiers = new Set<string>();
  for (const node of nodesOf(program)) {
    if (!isModuleLoad(node)) {
      continue;
    }
    const specifier = literalModuleRequest(node);
    if (specifier === undefined) {
      throw new Error(
        `${file}:${lineOf(node.start)} loads a module through a computed specifier, which the import graph cannot follow - use a string literal`,
      );
    }
    specifiers.add(specifier);
  }
  return [...specifiers].filter((specifier) => /^\.\.?\//.test(specifier));
}

/** Source spells the emitted `.js`, hence the `.ts` and `/index.ts` candidates. Nothing found throws: a dangling
 * specifier would silently drop an edge. */
function resolveImport(importer: string, specifier: string): string {
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

/** The src/ files under the lint, root-relative. */
function* sourceFiles(root: string, arch: Architecture): Generator<string> {
  const excluded = arch.exclude.map((pattern) => new Bun.Glob(pattern));
  for (const entry of readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })) {
    const file = join("src", entry);
    if (file.endsWith(".ts") && !excluded.some((glob) => glob.match(file))) {
      yield file;
    }
  }
}

export function lintArchitecture(root: string, arch = readArchitecture(root)): string[] {
  const drawn = new Map<string, string[]>();
  const problems: string[] = [];
  for (const file of sourceFiles(root, arch)) {
    const from = layerOf(arch, file);
    if (from === undefined) {
      problems.push(`${file} belongs to no layer in ${ARCHITECTURE_PATH}`);
      continue;
    }
    const absolute = join(root, file);
    for (const specifier of importSpecifiers(readFileSync(absolute, "utf8"), absolute)) {
      const target = relative(root, resolveImport(absolute, specifier));
      const to = layerOf(arch, target);
      if (to === undefined) {
        problems.push(
          `${target} (imported by ${file}) belongs to no layer in ${ARCHITECTURE_PATH}`,
        );
      } else if (to !== from) {
        const key = `${from} -> ${to}`;
        drawn.set(key, [...(drawn.get(key) ?? []), `${file} -> ${target}`]);
      }
    }
  }
  const declared = new Set(
    Object.entries(arch.edges).flatMap(([from, targets]) =>
      targets.map((to) => `${from} -> ${to}`),
    ),
  );
  for (const [key, sites] of [...drawn].sort()) {
    if (!declared.has(key)) {
      problems.push(`forbidden import ${key}: ${sites.join(", ")}; move it or declare the edge`);
    }
  }
  for (const key of [...declared].sort()) {
    if (!drawn.has(key)) {
      problems.push(
        `stale allowance ${key}: no file draws it; remove it from ${ARCHITECTURE_PATH}`,
      );
    }
  }
  return problems;
}

/** A hyphen in a layer name is edge syntax to mermaid, so ids swap it for an underscore. */
export function renderArchitectureMermaid(arch: Architecture): string {
  const id = (layer: string): string => layer.replace(/-/g, "_");
  return [
    "graph TD",
    ...Object.entries(arch.layers).map(([name, paths]) => `  ${id(name)}["${paths.join("<br>")}"]`),
    ...Object.entries(arch.edges).flatMap(([from, targets]) =>
      targets.map((to) => `  ${id(from)} --> ${id(to)}`),
    ),
  ].join("\n");
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..", "..");
  const problems = parseArchitecture(root).match(
    (arch) => lintArchitecture(root, arch),
    (problems) => problems,
  );
  if (problems.length > 0) {
    console.error(
      `lint:arch: ${countNoun(problems.length, "problem", "problems")}\n  ${problems.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(`lint:arch: src/ imports match ${ARCHITECTURE_PATH}`);
}
