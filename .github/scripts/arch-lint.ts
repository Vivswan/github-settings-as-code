/**
 * The architecture lint (bun run lint:arch): src/ imports between layers must be exactly the edges architecture.yml
 * declares; an undeclared edge and a stale allowance both fail. dependency-cruiser was the intended tool, but it
 * needs the TypeScript compiler API, which the pinned typescript 7 no longer ships, so it resolves nothing here.
 *   runtime loads (what the changed-sections scanner reads)                   -> edges
 *   type-only imports, re-exports                                            -> edges too
 *   `import("./x.js").T`, `import X = require("./x.js")` in type positions   -> edges too
 *
 * The same walk carries the never-throw rule the `throws` block of architecture.yml states beside its lists.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Node, parseSync } from "oxc-parser";
import { parse as parseYaml } from "yaml";
import { countNoun } from "../../src/text.js";
import { resolveImport, scanImports } from "./changed-sections.js";

export const ARCHITECTURE_PATH = "architecture.yml";

export interface Throws {
  /** Files whose throws are spared until the request layer returns Results. */
  readonly requestLayer: readonly string[];
  /** file -> its exact count of throws outside the rule. */
  readonly ratchet: Readonly<Record<string, number>>;
}

export interface Architecture {
  /** layer -> the src/ paths it owns (a `/` suffix means a directory). */
  readonly layers: Readonly<Record<string, readonly string[]>>;
  readonly exclude: readonly string[];
  /** from -> the layers it may import. */
  readonly edges: Readonly<Record<string, readonly string[]>>;
  readonly throws: Throws;
}

export function readArchitecture(root: string): Architecture {
  return parseYaml(readFileSync(join(root, ARCHITECTURE_PATH), "utf8")) as Architecture;
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

export function importSpecifiers(text: string, file: string): string[] {
  const { program, module } = parseSync(file, text);
  const typeLevel = [...nodesOf(program)].flatMap((node) => {
    const source =
      node.type === "TSImportType"
        ? node.source
        : node.type === "TSExternalModuleReference"
          ? node.expression
          : undefined;
    return source?.type === "Literal" && typeof source.value === "string" ? [source.value] : [];
  });
  const all = new Set([
    ...scanImports(text, file),
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((item) => (item.moduleRequest ? [item.moduleRequest.value] : [])),
    ),
    ...typeLevel,
  ]);
  return [...all].filter((specifier) => /^\.\.?\//.test(specifier));
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

type ThrowStatement = Extract<Node, { type: "ThrowStatement" }>;
/** The names a binding pattern declares; a destructuring key is not one of them. */
function bindingNames(pattern: Node): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        bindingNames(property.type === "RestElement" ? property.argument : property.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) => (element ? bindingNames(element) : []));
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    case "RestElement":
      return bindingNames(pattern.argument);
    default:
      return [];
  }
}

/** Whether a block redeclares `name` with a binding of its own: a variable, or anything declared under an `id`
 * (a function, class, enum, or namespace). */
function redeclares(block: Extract<Node, { type: "BlockStatement" }>, name: string): boolean {
  return block.body.some((statement) =>
    statement.type === "VariableDeclaration"
      ? statement.declarations.some((declaration) => bindingNames(declaration.id).includes(name))
      : "id" in statement &&
        statement.id !== null &&
        typeof statement.id === "object" &&
        statement.id.type === "Identifier" &&
        statement.id.name === name,
  );
}

/** Every throw, with the catch binding it may rethrow: the clause's own identifier, carried only through blocks and
 * if-statements that do not redeclare it. A loop, a switch, a nested function, or anything else on the way drops
 * it, so a throw there is judged on its own. */
function* throwsOf(
  value: unknown,
  rethrowable?: string,
): Generator<{ node: ThrowStatement; rethrowable: string | undefined }> {
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* throwsOf(item, rethrowable);
    }
  } else if (typeof value === "object" && value !== null && "type" in value) {
    const node = value as Node;
    if (node.type === "ThrowStatement") {
      yield { node, rethrowable };
    }
    const carried =
      node.type === "CatchClause"
        ? node.param?.type === "Identifier"
          ? node.param.name
          : undefined
        : node.type === "IfStatement" ||
            (node.type === "BlockStatement" &&
              rethrowable !== undefined &&
              !redeclares(node, rethrowable))
          ? rethrowable
          : undefined;
    for (const child of Object.values(node)) {
      yield* throwsOf(child, carried);
    }
  }
}

/** `new X("BUG: ...")` or `new X(\`BUG: ${...}\`)`, X any Error class: a programming error no user can cause. */
function isBugInvariant(argument: ThrowStatement["argument"]): boolean {
  if (argument.type !== "NewExpression") {
    return false;
  }
  const [first] = argument.arguments;
  const head =
    first?.type === "Literal"
      ? first.value
      : first?.type === "TemplateLiteral"
        ? first.quasis[0]?.value.cooked
        : undefined;
  return typeof head === "string" && head.startsWith("BUG:");
}

export interface ThrowCensus {
  bug: number;
  rethrow: number;
  requestLayer: number;
  /** Throws outside the rule, whether or not the ratchet lists them. */
  ratchet: number;
}

const OUTSIDE_RULE =
  "not a BUG: invariant, not a bare rethrow inside its catch clause, and the file is not in throws.requestLayer";

export function lintThrows(
  root: string,
  arch = readArchitecture(root),
): { problems: string[]; census: ThrowCensus } {
  const census: ThrowCensus = { bug: 0, rethrow: 0, requestLayer: 0, ratchet: 0 };
  const spared = new Set(arch.throws.requestLayer);
  const sparedInUse = new Set<string>();
  const outside = new Map<string, number[]>();
  const problems: string[] = [];
  for (const file of sourceFiles(root, arch)) {
    const text = readFileSync(join(root, file), "utf8");
    const { program, errors } = parseSync(join(root, file), text);
    if (errors.length > 0) {
      problems.push(`${file} does not parse, so its throws are uncounted: ${errors[0]?.message}`);
      continue;
    }
    for (const { node, rethrowable } of throwsOf(program)) {
      if (isBugInvariant(node.argument)) {
        census.bug += 1;
      } else if (node.argument.type === "Identifier" && node.argument.name === rethrowable) {
        census.rethrow += 1;
      } else if (spared.has(file)) {
        census.requestLayer += 1;
        sparedInUse.add(file);
      } else {
        census.ratchet += 1;
        const line = text.slice(0, node.start).split("\n").length;
        outside.set(file, [...(outside.get(file) ?? []), line]);
      }
    }
  }
  for (const [file, lines] of [...outside].sort()) {
    const listed = arch.throws.ratchet[file];
    const sites = lines.map((line) => `${file}:${line}`).join(", ");
    if (listed === undefined) {
      problems.push(
        ...lines.map(
          (line) =>
            `${file}:${line} throws outside the rule: ${OUTSIDE_RULE}; return a Result, or add the file to throws.ratchet`,
        ),
      );
    } else if (lines.length > listed) {
      problems.push(
        `${file} throws ${lines.length} times outside the rule, throws.ratchet allows ${listed}: ${sites}; return a Result instead`,
      );
    } else if (lines.length < listed) {
      problems.push(
        `${file} throws ${lines.length} times outside the rule, throws.ratchet lists ${listed}; lower it to ${lines.length}`,
      );
    }
  }
  for (const file of Object.keys(arch.throws.ratchet).sort()) {
    if (!outside.has(file)) {
      problems.push(
        `stale ratchet ${file}: no throw outside the rule remains; remove it from throws.ratchet`,
      );
    }
  }
  for (const file of [...spared].sort()) {
    if (!sparedInUse.has(file)) {
      problems.push(
        `stale allowance throws.requestLayer ${file}: no throw remains there; remove it`,
      );
    }
  }
  return { problems, census };
}

export function describeThrowCensus({ bug, rethrow, requestLayer, ratchet }: ThrowCensus): string {
  return `throws: ${bug} BUG: invariants, ${rethrow} rethrows, ${requestLayer} in the request layer, ${ratchet} ratcheted outside the rule`;
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
  const arch = readArchitecture(root);
  const throws = lintThrows(root, arch);
  const problems = [...lintArchitecture(root, arch), ...throws.problems];
  console.log(`lint:arch: ${describeThrowCensus(throws.census)}`);
  if (problems.length > 0) {
    console.error(
      `lint:arch: ${countNoun(problems.length, "problem", "problems")}\n  ${problems.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(`lint:arch: src/ imports and throws match ${ARCHITECTURE_PATH}`);
}
