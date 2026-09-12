/**
 * The verdict `bun run lint:arch` prints, so CI's test job carries the gate; every import form the scanner must read has a control, since a missed
 * form would let a forbidden import pass.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ARCHITECTURE_PATH,
  importSpecifiers,
  lintArchitecture,
  readArchitecture,
  renderArchitectureMermaid,
} from "../../.github/scripts/arch-lint.js";

const ROOT = join(import.meta.dir, "..", "..");

describe("architecture.yml against src/", () => {
  const arch = readArchitecture(ROOT);

  test("declares exactly the cross-layer imports the tree draws", () => {
    expect(lintArchitecture(ROOT)).toEqual([]);
  });

  test("a forbidden edge fails naming both files (negative control)", () => {
    const problems = lintArchitecture(ROOT, { ...arch, edges: { ...arch.edges, main: [] } });
    expect(problems).toEqual([
      "forbidden import main -> action: src/main.ts -> src/action/io.ts, src/main.ts -> src/action/run.ts; move it or declare the edge",
    ]);
  });

  test("a stale allowance fails (negative control)", () => {
    expect(lintArchitecture(ROOT, { ...arch, edges: { ...arch.edges, types: ["io"] } })).toEqual([
      `stale allowance types -> io: no file draws it; remove it from ${ARCHITECTURE_PATH}`,
    ]);
  });

  test("a file outside every layer is reported, not dropped (negative control)", () => {
    const { main: _main, ...layers } = arch.layers;
    const { main: _edge, ...edges } = arch.edges;
    expect(lintArchitecture(ROOT, { ...arch, layers, edges })).toEqual([
      `src/main.ts belongs to no layer in ${ARCHITECTURE_PATH}`,
    ]);
  });

  test("the mermaid map carries one node per layer and one arrow per declared edge", () => {
    const lines = renderArchitectureMermaid(arch).split("\n");
    expect(lines[0]).toBe("graph TD");
    expect(lines.filter((line) => line.includes('["'))).toHaveLength(
      Object.keys(arch.layers).length,
    );
    const arrows = lines.filter((line) => line.includes(" --> "));
    expect(arrows).toHaveLength(Object.values(arch.edges).flat().length);
    expect(arrows).toContain("  engine --> plain_data");
  });
});

describe("importSpecifiers", () => {
  test.each<[string, string, string[]]>([
    ["a runtime import", 'import { a } from "./a.js";', ["./a.js"]],
    ["a type-only import", 'import type { A } from "./a.js";', ["./a.js"]],
    ["a side-effect import", 'import "./a.js";', ["./a.js"]],
    ["a re-export", 'export { a } from "./a.js";', ["./a.js"]],
    ["a star re-export", 'export * from "./a.js";', ["./a.js"]],
    ["a require call", 'const a = require("./a.js");', ["./a.js"]],
    ["a literal dynamic import", 'const a = await import("./a.js");', ["./a.js"]],
    ["an import in a type position", 'export type A = import("./a.js").A;', ["./a.js"]],
    ["a typeof import in a type position", 'type A = typeof import("./a.js");', ["./a.js"]],
    ["a type-only import-equals", 'import type A = require("./a.js");', ["./a.js"]],
    ["an import-equals", 'import A = require("./a.js");', ["./a.js"]],
    ["a package import, which is not an edge", 'import { z } from "zod";', []],
    [
      "one file named several ways, once",
      'import type { A } from "./a.js"; export { b } from "./a.js"; import "../up.js";',
      ["./a.js", "../up.js"],
    ],
  ])("reads %s", (_case, text, specifiers) => {
    expect(importSpecifiers(text, "x.ts")).toEqual(specifiers);
  });

  test("a computed dynamic import throws rather than dropping the edge", () => {
    // The whole message: the scanner is shared with changed-sections, so under lint:arch it must not blame that tool.
    expect(() => importSpecifiers('const m = "./a.js"; await import(m);', "x.ts")).toThrow(
      new Error(
        "x.ts:1 loads a module through a computed specifier, which the import graph cannot follow - use a string literal",
      ),
    );
  });
});
