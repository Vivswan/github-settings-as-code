/**
 * The verdict `bun run lint:arch` prints, so CI's test job carries the gate; every import form the scanner must read
 * has a control, since a missed form would let a forbidden import pass.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { err } from "neverthrow";
import {
  ARCHITECTURE_PATH,
  importSpecifiers,
  lintArchitecture,
  parseArchitecture,
  readArchitecture,
  renderArchitectureMermaid,
} from "../../.github/scripts/arch-lint.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

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
    ["a star re-export", 'export * from "./a.js";', ["./a.js"]],
    ["a require call", 'const a = require("./a.js");', ["./a.js"]],
    ["a literal dynamic import", 'const a = await import("./a.js");', ["./a.js"]],
    [
      "a template dynamic import with no expression",
      "const a = await import(`./a.js`);",
      ["./a.js"],
    ],
    [
      "a file opening with a shebang, as the bin entry does",
      '#!/usr/bin/env node\nimport { a } from "./a.js";',
      ["./a.js"],
    ],
    ["an inline type-only specifier", 'import { type A } from "./a.js";', ["./a.js"]],
    ["a runtime import-equals", 'import A = require("./a.js");', ["./a.js"]],
    [
      "a require or its argument behind parentheses, a non-null assertion, a cast, or a type argument",
      [
        'const a = (require)("./a.js");',
        'const b = require!("./b.js");',
        'const c = (require as any)("./c.js");',
        'const d = ((require as <T>(id: string) => T)<number>)("./d.js");',
        'const e = require(("./e.js"));',
        'const f = require("./f.js" as string);',
      ].join("\n"),
      ["./a.js", "./b.js", "./c.js", "./d.js", "./e.js", "./f.js"],
    ],
    ["an import in a type position", 'export type A = import("./a.js").A;', ["./a.js"]],
    ["a type-only import-equals", 'import type A = require("./a.js");', ["./a.js"]],
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
    // The whole message, with the file and line: the fix is in that file, not in the lint.
    for (const [text, form] of [
      ['const m = "./a.js";\nawait import(m);', "import(m)"],
      ['const m = "./a.js";\nconst a = require(m);', "require(m)"],
      [`const m = "a";\nawait import(\`./\${m}.js\`);`, "a template with an expression"],
    ] as const) {
      expect(() => importSpecifiers(text, "x.ts"), form).toThrow(
        new Error(
          "x.ts:2 loads a module through a computed specifier, which the import graph cannot follow - use a string literal",
        ),
      );
    }
  });

  test("a file that does not parse throws naming the line rather than reading a partial graph", () => {
    expect(() =>
      importSpecifiers('import { a } from "./a.js";\nexport function broken(: never {', "x.ts"),
    ).toThrow(/^x\.ts:2 does not parse: /);
  });
});

describe("parseArchitecture", () => {
  function parse(dir: string, document: string) {
    writeFileSync(join(dir, ARCHITECTURE_PATH), `${document}\n`);
    return parseArchitecture(dir);
  }

  test.each<[string, string, string[]]>([
    [
      "a missing key",
      "layers: {}\nexclude: []\nedge: {}",
      ["edges is missing", "unknown key edge"],
    ],
    [
      "a layer whose paths are not a list",
      "layers: {engine: src/engine/}\nexclude: []\nedges: {}",
      ["layers.engine is 'src/engine/'; Invalid input: expected array, received string"],
    ],
    [
      "an unresolved yaml alias",
      "layers: {}\nexclude: []\nedges: *missing",
      ["Unresolved alias (the anchor must be set before the alias): missing"],
    ],
    [
      "a yaml syntax error",
      "layers: {}\nexclude: []\nedges: [",
      [
        "Flow sequence in block collection must be sufficiently indented and end with a ] at line 4, column 1",
      ],
    ],
  ])("%s fails naming the key", (_case, document, problems) =>
    withTempDir("arch-lint-parse-", (dir) => {
      expect(parse(dir, document)).toEqual(err(problems.map((p) => `${ARCHITECTURE_PATH}: ${p}`)));
    }),
  );
});
