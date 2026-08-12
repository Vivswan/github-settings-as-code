/**
 * Unit tests for the pure logic of the gaps toolchain: compiler-output
 * parsing, the graduate-vs-foreign split, the spec-only rewrite template,
 * and the wholesale index generation. Fixture strings stand in for the
 * compiler and for gap files in the pure-logic blocks; a final block runs
 * the same functions against the real directory. The loud-failure paths
 * (foreign diagnostics, unparsable output, an unrecognizable gap file)
 * matter as much as the happy ones: the scripts must refuse to half-fix.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  camelCaseGapName,
  gapFileBases,
  generateIndex,
} from "../../.github/scripts/gen-gaps-index.js";
import {
  isGapFile,
  isSpecOnly,
  isSpecPinned,
  parseDiagnostics,
  planGraduation,
  toSpecOnlyGapSource,
} from "../../.github/scripts/graduate-upstream-gaps.js";

const TRIPWIRE_MESSAGE =
  "Type '\"GET /repos/{owner}/{repo}/merge-queue\"' does not satisfy the constraint 'never'.";

describe("parseDiagnostics", () => {
  test("parses --pretty false diagnostic lines", () => {
    const output = [
      `src/upstream-gaps/merge-queue.ts(12,34): error TS2344: ${TRIPWIRE_MESSAGE}`,
      "src/engine/diff.ts(7,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      "",
    ].join("\n");
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(unparsed).toEqual([]);
    expect(diagnostics).toEqual([
      {
        file: "src/upstream-gaps/merge-queue.ts",
        line: 12,
        column: 34,
        code: 2344,
        message: TRIPWIRE_MESSAGE,
      },
      {
        file: "src/engine/diff.ts",
        line: 7,
        column: 3,
        code: 2322,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
  });

  test("tolerates CRLF line endings", () => {
    const { diagnostics, unparsed } = parseDiagnostics(
      "src/upstream-gaps/a.ts(1,1): error TS2344: boom\r\n",
    );
    expect(unparsed).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toBe("boom");
  });

  test("attaches indented continuation lines to the diagnostic above them", () => {
    // Real tsgo 7.0.2 --pretty false output for a chained error: the nested
    // explanations continue on indented lines under the diagnostic.
    const output = [
      "src/chain.ts(3,29): error TS2345: Argument of type '{ a: { b: string; }; }' is not assignable to parameter of type '{ a: { b: number; }; }'.",
      "  The types of 'a.b' are incompatible between these types.",
      "    Type 'string' is not assignable to type 'number'.",
      "src/other.ts(9,1): error TS2304: Cannot find name 'nope'.",
    ].join("\n");
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(unparsed).toEqual([]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.code).toBe(2345);
    expect(diagnostics[0]?.message).toBe(
      [
        "Argument of type '{ a: { b: string; }; }' is not assignable to parameter of type '{ a: { b: number; }; }'.",
        "  The types of 'a.b' are incompatible between these types.",
        "    Type 'string' is not assignable to type 'number'.",
      ].join("\n"),
    );
    expect(diagnostics[1]?.message).toBe("Cannot find name 'nope'.");
  });

  test("a chained TS2344 tripwire still graduates its gap file", () => {
    // A tripwire whose constraint is object-shaped chains its message; the
    // continuation lines must not turn the diagnostic into unparsed noise.
    const output = [
      "src/upstream-gaps/merge-queue.ts(12,34): error TS2344: Type '{ route: string; }' does not satisfy the constraint 'never'.",
      "  Types of property 'route' are incompatible.",
    ].join("\n");
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(unparsed).toEqual([]);
    const plan = planGraduation(diagnostics);
    expect(plan.foreign).toEqual([]);
    expect(plan.gapFiles).toEqual(["src/upstream-gaps/merge-queue.ts"]);
  });

  test("an indented line with no diagnostic above it stays unparsed", () => {
    const output = ["not a diagnostic", "  looks like a continuation"].join("\n");
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(diagnostics).toEqual([]);
    expect(unparsed).toEqual(["not a diagnostic", "  looks like a continuation"]);
  });

  test("collects non-diagnostic lines as unparsed instead of guessing", () => {
    const output = [
      "error TS5112: Option 'project' cannot be mixed with source files on a command line.",
      "src/upstream-gaps/a.ts(1,1): error TS2344: boom",
      "some stray crash line",
    ].join("\n");
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(diagnostics).toHaveLength(1);
    expect(unparsed).toEqual([
      "error TS5112: Option 'project' cannot be mixed with source files on a command line.",
      "some stray crash line",
    ]);
  });
});

describe("isGapFile", () => {
  test("accepts only .ts files directly under src/upstream-gaps/", () => {
    expect(isGapFile("src/upstream-gaps/merge-queue.ts")).toBe(true);
    expect(isGapFile("src/upstream-gaps/nested/deep.ts")).toBe(false);
    expect(isGapFile("src/sections/labels.ts")).toBe(false);
    expect(isGapFile("src/upstream-gaps.ts")).toBe(false);
  });

  test("the directory's infrastructure files are never graduatable", () => {
    // index.ts and gap.ts carry no tripwire; a TS2344 in either means the
    // machinery itself broke, and deleting it could never be the fix.
    expect(isGapFile("src/upstream-gaps/index.ts")).toBe(false);
    expect(isGapFile("src/upstream-gaps/gap.ts")).toBe(false);
    for (const file of ["src/upstream-gaps/index.ts", "src/upstream-gaps/gap.ts"]) {
      const plan = planGraduation([
        { file, line: 1, column: 1, code: 2344, message: "tripwire-shaped noise" },
      ]);
      expect(plan.gapFiles).toEqual([]);
      expect(plan.foreign).toHaveLength(1);
    }
  });
});

describe("planGraduation", () => {
  const tripwire = (file: string) => ({
    file,
    line: 10,
    column: 20,
    code: 2344,
    message: TRIPWIRE_MESSAGE,
  });

  test("collects tripped gap files, deduplicated and sorted", () => {
    const plan = planGraduation([
      tripwire("src/upstream-gaps/pages-https.ts"),
      tripwire("src/upstream-gaps/merge-queue.ts"),
      tripwire("src/upstream-gaps/merge-queue.ts"),
    ]);
    expect(plan.foreign).toEqual([]);
    expect(plan.gapFiles).toEqual([
      "src/upstream-gaps/merge-queue.ts",
      "src/upstream-gaps/pages-https.ts",
    ]);
  });

  test("a TS2344 outside the gaps directory is foreign", () => {
    const plan = planGraduation([tripwire("src/sections/labels.ts")]);
    expect(plan.gapFiles).toEqual([]);
    expect(plan.foreign).toHaveLength(1);
  });

  test("a TS2344 in index.ts is foreign (the index carries no tripwire)", () => {
    const plan = planGraduation([tripwire("src/upstream-gaps/index.ts")]);
    expect(plan.gapFiles).toEqual([]);
    expect(plan.foreign).toHaveLength(1);
  });

  test("a non-2344 error inside a gap file is foreign", () => {
    const plan = planGraduation([
      {
        file: "src/upstream-gaps/merge-queue.ts",
        line: 1,
        column: 1,
        code: 2322,
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
    expect(plan.gapFiles).toEqual([]);
    expect(plan.foreign).toHaveLength(1);
  });

  test("one foreign diagnostic does not hide the graduatable ones", () => {
    const plan = planGraduation([
      tripwire("src/upstream-gaps/merge-queue.ts"),
      tripwire("src/engine/diff.ts"),
    ]);
    expect(plan.gapFiles).toEqual(["src/upstream-gaps/merge-queue.ts"]);
    expect(plan.foreign).toHaveLength(1);
  });
});

describe("camelCaseGapName", () => {
  test("maps kebab file bases to the index import alias", () => {
    expect(camelCaseGapName("merge-queue")).toBe("mergeQueue");
    expect(camelCaseGapName("pages")).toBe("pages");
    expect(camelCaseGapName("a-b-c")).toBe("aBC");
    expect(camelCaseGapName("code-scanning-2")).toBe("codeScanning2");
  });
});

describe("gapFileBases", () => {
  test("keeps only gap .ts files, stripped and sorted", () => {
    expect(
      gapFileBases(["pages-https.ts", "index.ts", "gap.ts", "merge-queue.ts", "README.md"]),
    ).toEqual(["merge-queue", "pages-https"]);
  });

  test("declaration and test strays never become phantom gaps", () => {
    expect(gapFileBases(["notes.d.ts", "scratch.test.ts", "merge-queue.ts"])).toEqual([
      "merge-queue",
    ]);
    expect(isGapFile("src/upstream-gaps/notes.d.ts")).toBe(false);
    expect(isGapFile("src/upstream-gaps/scratch.test.ts")).toBe(false);
  });

  test("an empty listing yields no bases", () => {
    expect(gapFileBases(["index.ts", "gap.ts"])).toEqual([]);
  });
});

describe("generateIndex", () => {
  test("is deterministic and sorts the bases itself", () => {
    const sorted = generateIndex(["merge-queue", "pages-https"]);
    expect(generateIndex(["pages-https", "merge-queue"])).toBe(sorted);
    expect(generateIndex(["merge-queue", "pages-https"])).toBe(sorted);
  });

  test("marks itself generated and un-editable in the header", () => {
    expect(generateIndex([])).toContain("GENERATED by gen-gaps-index.ts - do not edit");
  });

  test("emits one import and one GAPS element per gap file", () => {
    const index = generateIndex(["merge-queue", "pages-https"]);
    expect(index).toContain('import { GAP as mergeQueue } from "./merge-queue.js";');
    expect(index).toContain('import { GAP as pagesHttps } from "./pages-https.js";');
    expect(index).toContain('import { undocumentedRoutes } from "./gap.js";');
    expect(index).toContain("const GAPS = [\n  mergeQueue,\n  pagesHttps,\n] as const;");
  });

  test("separates the two gap kinds in the derivations", () => {
    const index = generateIndex(["merge-queue"]);
    expect(index).toContain(
      'export type SupplementalRoute = Extract<GapUnion, { kind: "octokit" }>["routes"][number];',
    );
    expect(index).toContain(
      'type SpecOnlyRoute = Extract<GapUnion, { kind: "spec-only" }>["routes"][number];',
    );
    expect(index).toContain(
      "export const UNDOCUMENTED_ROUTES: readonly (SupplementalRoute | SpecOnlyRoute)[] =",
    );
    expect(index).toContain("undocumentedRoutes<SupplementalRoute | SpecOnlyRoute>(GAPS);");
  });

  test("an empty directory degrades to an empty GAPS with both exports intact", () => {
    const index = generateIndex([]);
    expect(index).toContain("const GAPS = [] as const;");
    expect(index).toContain("export type SupplementalRoute");
    expect(index).toContain("export const UNDOCUMENTED_ROUTES");
    expect(index).not.toContain("GAP as");
  });

  test("ends with a trailing newline", () => {
    expect(generateIndex(["merge-queue"])).toEndWith("\n");
  });
});

describe("isSpecPinned", () => {
  test("detects the documentedInSpec: false flag in a gap source", () => {
    expect(isSpecPinned("documentedInSpec: false,")).toBe(true);
    expect(isSpecPinned("documentedInSpec: true,")).toBe(false);
    expect(isSpecPinned("routes only, spec-only shape")).toBe(false);
  });
});

describe("toSpecOnlyGapSource", () => {
  const GAP_FILE = "src/upstream-gaps/merge-queue.ts";
  const SOURCE = [
    'import type { Endpoints } from "@octokit/types";',
    'import type { MustBeNever } from "../schema.js";',
    'import { defineGap } from "./gap.js";',
    "",
    "/** GitHub shipped the merge queue; @octokit/types does not carry these routes yet, nor does the published OpenAPI description. */",
    "export const GAP = defineGap({",
    "  routes: [",
    '    "GET /repos/{owner}/{repo}/merge-queue",',
    '    "PATCH /repos/{owner}/{repo}/merge-queue/settings-and-more-padding",',
    '    "DELETE /repos/{owner}/{repo}/merge-queue/settings-and-more-padding",',
    "  ],",
    "  documentedInSpec: false,",
    "});",
    "",
    "/** Fires when @octokit/types gains any of these routes: DELETE THIS FILE and its two lines in index.ts. */",
    "type _DeleteThisFileOnceOctokitShipsIt = MustBeNever<",
    "  Extract<(typeof GAP.routes)[number], keyof Endpoints>",
    ">;",
    "",
  ].join("\n");

  test("rewrites a spec-pinned gap to the spec-only template", () => {
    expect(toSpecOnlyGapSource(SOURCE, GAP_FILE)).toBe(
      [
        'import { defineSpecOnlyGap } from "./gap.js";',
        "",
        "/** GitHub shipped the merge queue; @octokit/types ships these routes, but the pinned OpenAPI descriptor does not document them yet. */",
        "export const GAP = defineSpecOnlyGap({",
        "  routes: [",
        '    "GET /repos/{owner}/{repo}/merge-queue",',
        '    "PATCH /repos/{owner}/{repo}/merge-queue/settings-and-more-padding",',
        '    "DELETE /repos/{owner}/{repo}/merge-queue/settings-and-more-padding",',
        "  ],",
        "});",
        "",
      ].join("\n"),
    );
  });

  test("the rewritten doc keeps the feature clause and drops the stale octokit prose", () => {
    const result = toSpecOnlyGapSource(SOURCE, GAP_FILE);
    expect(result).toContain("/** GitHub shipped the merge queue; @octokit/types ships");
    expect(result).not.toContain("does not carry these routes");
  });

  test("the rewrite drops the tripwire, the flag, and their imports", () => {
    const result = toSpecOnlyGapSource(SOURCE, GAP_FILE);
    expect(result).not.toContain("MustBeNever");
    expect(result).not.toContain("Endpoints");
    expect(result).not.toContain("documentedInSpec");
    expect(result).not.toContain("defineGap(");
  });

  test("routes that fit the line width render inline, matching the formatter", () => {
    const short = SOURCE.replace(
      /routes: \[[\s\S]*?\],/,
      'routes: ["PUT /repos/{owner}/{repo}/lfs", "DELETE /repos/{owner}/{repo}/lfs"],',
    );
    expect(toSpecOnlyGapSource(short, GAP_FILE)).toContain(
      '  routes: ["PUT /repos/{owner}/{repo}/lfs", "DELETE /repos/{owner}/{repo}/lfs"],\n',
    );
  });

  test("a module-head comment is not mistaken for the GAP doc", () => {
    const withHead = `/** module-head prose that must NOT leak into the rewrite */\n${SOURCE}`;
    const result = toSpecOnlyGapSource(withHead, GAP_FILE);
    expect(result).not.toContain("module-head prose");
    expect(result).toContain("/** GitHub shipped the merge queue;");
  });

  test("a source without the defineGap shape throws loudly, naming the file", () => {
    expect(() => toSpecOnlyGapSource("export const GAP = 42;", GAP_FILE)).toThrow(
      /merge-queue\.ts does not match the documented defineGap shape/,
    );
  });

  test("a defineGap without parsable routes throws loudly", () => {
    const routeless = [
      "/** doc */",
      "export const GAP = defineGap({",
      "  routes: [],",
      "  documentedInSpec: false,",
      "});",
    ].join("\n");
    expect(() => toSpecOnlyGapSource(routeless, GAP_FILE)).toThrow(/no parsable routes/);
  });

  test("non-literal routes-array content is refused, not silently dropped", () => {
    const withIdentifier = SOURCE.replace(
      '"GET /repos/{owner}/{repo}/merge-queue",',
      "LIST_ROUTE,",
    );
    expect(() => toSpecOnlyGapSource(withIdentifier, GAP_FILE)).toThrow(
      /more than plain string literals.*LIST_ROUTE/,
    );
  });

  test("a commented-out route in the array is refused, not resurrected", () => {
    const withComment = SOURCE.replace(
      '"GET /repos/{owner}/{repo}/merge-queue",',
      '// dropped: "GET /repos/{owner}/{repo}/old"',
    );
    expect(() => toSpecOnlyGapSource(withComment, GAP_FILE)).toThrow(
      /more than plain string literals/,
    );
  });
});

/**
 * The fixtures above stand in for gap files and listings; this block pins
 * the scripts against the REAL src/upstream-gaps/ so drift can never ship:
 * the committed index must equal a fresh regeneration, every gap file must
 * agree with the flag detector, and every spec-pinned file must be
 * rewritable by the graduation transform.
 */
describe("the real src/upstream-gaps/ satisfies the scripts' contracts", () => {
  const GAPS_DIR = join(import.meta.dir, "..", "..", "src", "upstream-gaps");
  const realIndex = readFileSync(join(GAPS_DIR, "index.ts"), "utf8");
  const realGapFiles = readdirSync(GAPS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/upstream-gaps/${f}`)
    .filter((f) => isGapFile(f));

  test("the committed index equals a fresh regeneration", () => {
    expect(realIndex).toBe(generateIndex(gapFileBases(readdirSync(GAPS_DIR))));
  });

  test("spec-pinned detection agrees with each gap's actual kind and flag", async () => {
    for (const gap of realGapFiles) {
      const abs = join(import.meta.dir, "..", "..", gap);
      const { GAP } = (await import(abs)) as {
        GAP: { kind: "octokit"; documentedInSpec: boolean } | { kind: "spec-only" };
      };
      const expected = GAP.kind === "octokit" && !GAP.documentedInSpec;
      expect(isSpecPinned(readFileSync(abs, "utf8"))).toBe(expected);
    }
  });

  test("every real spec-pinned gap is rewritable to the spec-only template", async () => {
    for (const gap of realGapFiles) {
      const abs = join(import.meta.dir, "..", "..", gap);
      const source = readFileSync(abs, "utf8");
      if (!isSpecPinned(source)) {
        continue;
      }
      const { GAP } = (await import(abs)) as { GAP: { routes: readonly string[] } };
      const rewritten = toSpecOnlyGapSource(source, gap);
      expect(rewritten).toContain("defineSpecOnlyGap({");
      for (const route of GAP.routes) {
        expect(rewritten).toContain(`"${route}"`);
      }
    }
  });
});

describe("spec-only sources never reach the deletion branch", () => {
  test("isSpecOnly distinguishes the two gap kinds", () => {
    expect(isSpecOnly('export const GAP = defineSpecOnlyGap({\n  routes: ["GET /x"],\n});')).toBe(
      true,
    );
    expect(isSpecOnly("export const GAP = defineGap({ documentedInSpec: false });")).toBe(false);
  });
});
