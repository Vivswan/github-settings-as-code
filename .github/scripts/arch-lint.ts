/**
 * The architecture lint (bun run lint:arch): the imports between the layers
 * of src/ are exactly the edges architecture.yml declares - an undeclared
 * edge and a stale allowance both fail. gen-docs.ts renders the same
 * declaration as the module map. dependency-cruiser was the intended tool but
 * cannot cruise this repository: it needs the TypeScript compiler API, which
 * the pinned typescript 7 no longer ships, so it resolves nothing.
 *
 * An edge is any way one file names another: the runtime loads the
 * changed-sections scanner reads, plus type-only imports, re-exports, and
 * `import("./x.js").T` and `import X = require("./x.js")` in type positions.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Node, parseSync } from "oxc-parser";
import { parse as parseYaml } from "yaml";
import { resolveImport, scanImports } from "./changed-sections.js";

export const ARCHITECTURE_PATH = "architecture.yml";

export interface Architecture {
  /** layer -> the src/ paths it owns (a `/` suffix means a directory). */
  readonly layers: Readonly<Record<string, readonly string[]>>;
  readonly exclude: readonly string[];
  /** from -> the layers it may import. */
  readonly edges: Readonly<Record<string, readonly string[]>>;
}

export function readArchitecture(root: string): Architecture {
  return parseYaml(readFileSync(join(root, ARCHITECTURE_PATH), "utf8")) as Architecture;
}

/** The layer owning a repo-relative path, or undefined. */
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

/** Every relative specifier `text` names, runtime and type-level alike. */
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

/**
 * The lint verdict for `root`: an import between layers the declaration lacks
 * (naming both files), a declared edge no file draws, or a cruised file outside
 * every layer. Empty means the declaration is exactly the tree.
 */
export function lintArchitecture(root: string, arch = readArchitecture(root)): string[] {
  const excluded = arch.exclude.map((pattern) => new Bun.Glob(pattern));
  const drawn = new Map<string, string[]>();
  const problems: string[] = [];
  for (const entry of readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })) {
    const file = join("src", entry);
    if (!file.endsWith(".ts") || excluded.some((glob) => glob.match(file))) {
      continue;
    }
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

/** The module map over the DECLARED edges; a hyphen in a layer name is edge syntax to mermaid. */
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
  const problems = lintArchitecture(join(import.meta.dir, "..", ".."));
  if (problems.length > 0) {
    console.error(`lint:arch: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`lint:arch: src/ imports match ${ARCHITECTURE_PATH}`);
}
