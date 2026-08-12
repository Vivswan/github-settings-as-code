/**
 * Unit tests for the pure logic of the gap-graduation script: compiler-output
 * parsing, the graduate-vs-foreign split, the alias mapping, and the strict
 * index-line removal. Fixture strings stand in for the compiler and for
 * src/upstream-gaps/index.ts for the pure-logic blocks; a final block runs
 * the same functions against the real directory. The
 * loud-failure paths (foreign diagnostics, unparsable output, drifted index
 * layout) matter as much as the happy ones: the script must refuse to
 * half-fix.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  camelCaseGapName,
  isGapFile,
  isSpecPinned,
  parseDiagnostics,
  planGraduation,
  removeGapFromIndex,
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

describe("removeGapFromIndex", () => {
  const INDEX = [
    'import type { UpstreamGap } from "./contract.js";',
    'import { GAP as mergeQueue } from "./merge-queue.js";',
    'import { GAP as pagesHttps } from "./pages-https.js";',
    "",
    "const GAPS = [",
    "  mergeQueue,",
    "  pagesHttps,",
    "] as const;",
    "",
    "export const UPSTREAM_GAPS: readonly UpstreamGap[] = GAPS;",
    "",
  ].join("\n");

  test("removes exactly the import line and the array element line", () => {
    const result = removeGapFromIndex(INDEX, "src/upstream-gaps/merge-queue.ts");
    expect(result).toBe(
      [
        'import type { UpstreamGap } from "./contract.js";',
        'import { GAP as pagesHttps } from "./pages-https.js";',
        "",
        "const GAPS = [",
        "  pagesHttps,",
        "] as const;",
        "",
        "export const UPSTREAM_GAPS: readonly UpstreamGap[] = GAPS;",
        "",
      ].join("\n"),
    );
  });

  test("removing every gap leaves a valid empty array", () => {
    const result = removeGapFromIndex(
      removeGapFromIndex(INDEX, "src/upstream-gaps/merge-queue.ts"),
      "src/upstream-gaps/pages-https.ts",
    );
    expect(result).toContain("const GAPS = [\n] as const;");
    expect(result).not.toContain("GAP as");
  });

  test("a missing import line fails loudly", () => {
    expect(() => removeGapFromIndex(INDEX, "src/upstream-gaps/deploy-freeze.ts")).toThrow(
      /expected exactly one line .*deployFreeze.*found 0/,
    );
  });

  test("a missing array element line fails loudly and leaves nothing half-removed", () => {
    const importOnly = INDEX.replace("  mergeQueue,\n", "");
    expect(() => removeGapFromIndex(importOnly, "src/upstream-gaps/merge-queue.ts")).toThrow(
      /expected exactly one line ` {2}mergeQueue,` .*found 0/,
    );
  });

  test("a duplicated line fails loudly instead of removing both", () => {
    const duplicated = INDEX.replace("  mergeQueue,", "  mergeQueue,\n  mergeQueue,");
    expect(() => removeGapFromIndex(duplicated, "src/upstream-gaps/merge-queue.ts")).toThrow(
      /found 2/,
    );
  });

  test("a reformatted layout (indent drift) fails loudly", () => {
    const drifted = INDEX.replace("  mergeQueue,", "    mergeQueue,");
    expect(() => removeGapFromIndex(drifted, "src/upstream-gaps/merge-queue.ts")).toThrow(
      /found 0/,
    );
  });
});

/**
 * The fixtures above stand in for index.ts; this block pins the script
 * against the REAL src/upstream-gaps/ so layout drift between the two can
 * never ship: every real gap file must be removable from the real index,
 * and the array must keep its one-element-per-line shape (the biome-ignore
 * pin) or removeGapFromIndex stops matching after a graduation.
 */
describe("the real src/upstream-gaps/ satisfies the script's layout contract", () => {
  const GAPS_DIR = join(import.meta.dir, "..", "..", "src", "upstream-gaps");
  const realIndex = readFileSync(join(GAPS_DIR, "index.ts"), "utf8");
  const realGapFiles = readdirSync(GAPS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/upstream-gaps/${f}`)
    .filter((f) => isGapFile(f));

  test("the index imports exactly the gap files on disk (empty set included)", () => {
    const importedAliases = realIndex.match(/^import \{ GAP as /gm) ?? [];
    expect(importedAliases.length).toBe(realGapFiles.length);
  });

  test("every real gap file is selectable and removable from the real index", () => {
    for (const gap of realGapFiles) {
      const result = removeGapFromIndex(realIndex, gap);
      expect(result).not.toBe(realIndex);
    }
  });

  test("removing every gap in sequence leaves no gap lines behind", () => {
    let source = realIndex;
    for (const gap of realGapFiles) {
      source = removeGapFromIndex(source, gap);
    }
    expect(source).not.toContain("GAP as");
  });

  test("the index pins its array layout against the formatter", () => {
    expect(realIndex).toContain("// biome-ignore format:");
  });

  test("spec-pinned detection agrees with each gap's actual flag", async () => {
    for (const gap of realGapFiles) {
      const abs = join(import.meta.dir, "..", "..", gap);
      const { GAP } = (await import(abs)) as { GAP: { documentedInSpec: boolean } };
      expect(isSpecPinned(readFileSync(abs, "utf8"))).toBe(!GAP.documentedInSpec);
    }
  });
});
