/**
 * The verdict `bun run lint:arch` prints, so CI's test job carries the gate; every import form the scanner must read has a control, since a missed
 * form would let a forbidden import pass, and every throw class the never-throw rule names has one, since a missed class would let a throw pass.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err } from "neverthrow";
import {
  ARCHITECTURE_PATH,
  type Architecture,
  importSpecifiers,
  lintArchitecture,
  lintThrows,
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

  test("lists exactly the throws outside the never-throw rule the tree holds", () => {
    expect(lintThrows(ROOT, arch).problems).toEqual([]);
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
    // The whole message: the scanner is shared with changed-sections, so under lint:arch it must not blame that tool.
    expect(() => importSpecifiers('const m = "./a.js"; await import(m);', "x.ts")).toThrow(
      new Error(
        "x.ts:1 loads a module through a computed specifier, which the import graph cannot follow - use a string literal",
      ),
    );
  });
});

describe("lintThrows", () => {
  /** A src/ tree of `files` under a root, linted against `throws` alone. */
  function lint(dir: string, files: Record<string, string>, throws: Architecture["throws"]) {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return lintThrows(dir, { layers: {}, edges: {}, exclude: ["src/**/*.test.ts"], throws });
  }

  const OUTSIDE =
    "throws outside the rule: not a BUG: invariant, not a bare rethrow inside its catch clause, and the file is not in throws.requestLayer; return a Result, or add the file to throws.ratchet";

  test("each class lands in the census; a throw outside the rule, a rethrow from another scope, and a file that does not parse are reported, and a type alias does not shadow the binding", () =>
    withTempDir("arch-lint-throws-", (dir) => {
      const files = {
        "src/bug.ts": [
          "export function bug(x: unknown): never {",
          '  if (x === null) throw new Error("BUG: bug() was handed null");',
          `  throw new RangeError(\`BUG: bug() was handed \${String(x)}\`);`,
          "}",
        ].join("\n"),
        "src/rethrow.ts": [
          "export function rethrow(run: () => void, keep: boolean): void {",
          "  try {",
          "    run();",
          "  } catch (error) {",
          "    const { error: copy } = { error: 1 };",
          "    if (keep && copy === 1) {",
          "      throw error;",
          "    }",
          "    [1].forEach(() => {",
          "      throw error;",
          "    });",
          "  }",
          '  const error = new Error("x");',
          "  throw error;",
          "}",
        ].join("\n"),
        "src/shadow.ts": [
          "export function shadow(run: () => void, mode: number): void {",
          "  try {",
          "    run();",
          "  } catch (error) {",
          "    {",
          '      const error = new Error("x");',
          "      throw error;",
          "    }",
          "    {",
          "      enum error {",
          "        Other = 1,",
          "      }",
          "      throw error;",
          "    }",
          '    for (const error of [new Error("y")]) {',
          "      throw error;",
          "    }",
          "    switch (mode) {",
          "      default:",
          "        throw error;",
          "    }",
          "    {",
          "      type error = number;",
          "      throw error;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
        "src/spared.ts": 'export const spared = (): never => {\n  throw new Error("x");\n};',
        "src/plain.ts": 'export function plain(): never {\n  throw "x";\n}',
        "src/broken.ts": 'export function broken(): never {\n  throw "x";',
        "src/plain.test.ts": 'throw new Error("x");',
      };
      expect(lint(dir, files, { requestLayer: ["src/spared.ts"], ratchet: {} })).toEqual({
        problems: [
          expect.stringMatching(/^src\/broken\.ts does not parse, so its throws are uncounted: /),
          `src/plain.ts:2 ${OUTSIDE}`,
          `src/rethrow.ts:10 ${OUTSIDE}`,
          `src/rethrow.ts:14 ${OUTSIDE}`,
          `src/shadow.ts:7 ${OUTSIDE}`,
          `src/shadow.ts:13 ${OUTSIDE}`,
          `src/shadow.ts:16 ${OUTSIDE}`,
          `src/shadow.ts:20 ${OUTSIDE}`,
        ],
        census: { bug: 2, rethrow: 2, requestLayer: 1, outside: 7 },
      });
    }));

  test.each<[string, number, string[]]>([
    ["equal to", 2, []],
    [
      "under",
      1,
      [
        "src/two.ts throws 2 times outside the rule, throws.ratchet allows 1: src/two.ts:2, src/two.ts:3; return a Result instead",
      ],
    ],
    [
      "over",
      3,
      ["src/two.ts throws 2 times outside the rule, throws.ratchet lists 3; lower it to 2"],
    ],
  ])(
    "a ratchet count %s the file's count moves only by editing the list",
    (_case, listed, problems) =>
      withTempDir("arch-lint-ratchet-", (dir) => {
        const files = {
          "src/two.ts":
            'export function two(a: boolean): never {\n  if (a) throw new Error("x");\n  throw new Error("y");\n}',
        };
        expect(lint(dir, files, { requestLayer: [], ratchet: { "src/two.ts": listed } })).toEqual({
          problems,
          census: { bug: 0, rethrow: 0, requestLayer: 0, outside: 2 },
        });
      }),
  );

  test("a ratchet entry or a spared file with nothing left to spare is stale", () =>
    withTempDir("arch-lint-stale-", (dir) => {
      const files = {
        "src/clean.ts":
          'export function clean(): never {\n  throw new Error("BUG: clean() ran");\n}',
      };
      const throws = {
        requestLayer: ["src/clean.ts", "src/gone.ts"],
        ratchet: { "src/clean.ts": 1 },
      };
      expect(lint(dir, files, throws)).toEqual({
        problems: [
          "stale ratchet src/clean.ts: no throw outside the rule remains; remove it from throws.ratchet",
          "stale allowance throws.requestLayer src/clean.ts: no throw remains there; remove it",
          "stale allowance throws.requestLayer src/gone.ts: no throw remains there; remove it",
        ],
        census: { bug: 1, rethrow: 0, requestLayer: 0, outside: 0 },
      });
    }));
});

describe("parseArchitecture", () => {
  /** A declaration with `throws` replaced, beside one src/ file and one test/ file (so a path that leaves src/
   * through `..` still names a real file), parsed from a temp root. */
  function parse(dir: string, throws: string) {
    for (const file of ["src/x.ts", "test/x.ts"]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "export const x = 1;\n");
    }
    writeFileSync(
      join(dir, ARCHITECTURE_PATH),
      `layers: {}\nexclude: []\nedges: {}\n${throws}`.replaceAll("|", "\n"),
    );
    return parseArchitecture(dir);
  }

  test.each<[string, string, string]>([
    ["a word", "typo", "'typo'"],
    ["a yaml NaN", ".nan", "NaN"],
    ["a map", "{count: 1}", "{ count: 1 }"],
    ["a quoted number", '"1"', "'1'"],
    ["a fraction", "1.5", "1.5"],
    ["a negative", "-1", "-1"],
  ])("a ratchet count that is %s fails naming the key and the value", (_case, value, shown) =>
    withTempDir("arch-lint-parse-", (dir) => {
      const throws = `throws:|  requestLayer: []|  ratchet:|    src/x.ts: ${value}`;
      expect(parse(dir, throws)).toEqual(
        err([
          `${ARCHITECTURE_PATH}: throws.ratchet["src/x.ts"] is ${shown}; expected a whole number of throws`,
        ]),
      );
    }),
  );

  test.each<[string, string, string[]]>([
    ["a missing ratchet", "throws:|  requestLayer: []", ["throws.ratchet is missing"]],
    [
      "a misspelled ratchet",
      "throws:|  requestLayer: []|  ratchets: {}",
      ["throws.ratchet is missing", "unknown key throws.ratchets"],
    ],
    ["a misspelled throws", "throw: {}", ["throws is missing", "unknown key throw"]],
    [
      "a ratchet path that is no file",
      "throws:|  requestLayer: []|  ratchet:|    src/gone.ts: 1",
      [`throws.ratchet["src/gone.ts"] names no file under src/: 'src/gone.ts'`],
    ],
    [
      "a spared path outside src/",
      "throws:|  requestLayer: [test/x.ts]|  ratchet: {}",
      ["throws.requestLayer[0] names no file under src/: 'test/x.ts'"],
    ],
    [
      "a spared path through a file",
      "throws:|  requestLayer: [src/x.ts/y.ts]|  ratchet: {}",
      ["throws.requestLayer[0] names no file under src/: 'src/x.ts/y.ts'"],
    ],
    [
      "a spared path that leaves src/ through a parent segment",
      "throws:|  requestLayer: [src/../test/x.ts]|  ratchet: {}",
      ["throws.requestLayer[0] names no file under src/: 'src/../test/x.ts'"],
    ],
    [
      "an unresolved yaml alias",
      "throws: {requestLayer: [], ratchet: *missing}",
      ["Unresolved alias (the anchor must be set before the alias): missing"],
    ],
    [
      "a yaml syntax error",
      "throws: [",
      [
        "Flow sequence in block collection must be sufficiently indented and end with a ] at line 4, column 10",
      ],
    ],
  ])("%s fails naming the key", (_case, throws, problems) =>
    withTempDir("arch-lint-parse-", (dir) => {
      expect(parse(dir, throws)).toEqual(err(problems.map((p) => `${ARCHITECTURE_PATH}: ${p}`)));
    }),
  );
});
