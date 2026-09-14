import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  camelCaseGapName,
  gapFileBases,
  generateIndex,
  indexSummary,
} from "../../.github/scripts/gen-gaps-index.js";
import {
  isGapFile,
  isSpecOnly,
  isSpecPinned,
  parseDiagnostics,
  planGraduation,
  toSpecOnlyGapSource,
} from "../../.github/scripts/graduate-upstream-gaps.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

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
    // Real tsgo 7.0.2 --pretty false output: a chained error continues on indented lines under the diagnostic.
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

  test("lines that are neither a diagnostic nor its continuation stay unparsed, and end the diagnostic above them", () => {
    const output = [
      "error TS5112: Option 'project' cannot be mixed with source files on a command line.",
      "src/upstream-gaps/a.ts(1,1): error TS2344: boom",
      "some stray crash line",
      "  looks like a continuation, but the stray line above ended the diagnostic",
    ].join("\n");
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["boom"]);
    expect(unparsed).toEqual([
      "error TS5112: Option 'project' cannot be mixed with source files on a command line.",
      "some stray crash line",
      "  looks like a continuation, but the stray line above ended the diagnostic",
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
    // index.ts and gap.ts carry no tripwire; a TS2344 in either means the machinery broke, and deleting it could never be the fix.
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
});

describe("generateIndex", () => {
  test("one import and one GAPS element per gap file, aliased and sorted; an empty directory keeps the same template around an empty GAPS", () => {
    // The varying parts of the file: the gap imports (gap.js's is the template's) and the GAPS array, whole.
    const gapImports = (text: string): string[] => text.match(/^import \{ GAP as .*$/gm) ?? [];
    const gapsArray = (text: string): string =>
      text.match(/const GAPS = [\s\S]*?\] as const;/)?.[0] ?? "";
    const two = generateIndex(["pages-https", "merge-queue"]);
    expect(gapImports(two)).toEqual([
      'import { GAP as mergeQueue } from "./merge-queue.js";',
      'import { GAP as pagesHttps } from "./pages-https.js";',
    ]);
    expect(gapsArray(two)).toBe("const GAPS = [\n  mergeQueue,\n  pagesHttps,\n] as const;");
    const none = generateIndex([]);
    expect(gapImports(none)).toEqual([]);
    expect(gapsArray(none)).toBe("const GAPS = [] as const;");
    // Everything but the imports and the GAPS elements is one template, so the derivations the consumers import
    // (SupplementalRoute, UNDOCUMENTED_ROUTES) are the same text whatever the directory holds.
    const template = (text: string): string =>
      text.replace(/^import \{ GAP as .*\n/gm, "").replace(gapsArray(text), "");
    expect(template(none)).toBe(template(two));
    expect(none).toContain("export type SupplementalRoute");
    expect(none).toContain("export const UNDOCUMENTED_ROUTES");
  });

  test("the empty index type-checks beside gap.ts: the derivations must not index into an empty tuple", () =>
    withTempDir("gaps-index-empty-", (dir) => {
      // The committed index compiles under the project typecheck only while a gap file exists; a derivation
      // written for a populated GAPS (say `(typeof GAPS)[0]`) would first break the day the last gap graduates.
      symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
      copyFileSync(join(ROOT, "src", "upstream-gaps", "gap.ts"), join(dir, "gap.ts"));
      writeFileSync(join(dir, "index.ts"), generateIndex([]));
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({ extends: join(ROOT, "tsconfig.json"), include: [], files: ["index.ts"] }),
      );
      const tsc = spawnSync(
        join(ROOT, "node_modules", ".bin", "tsc"),
        ["-p", dir, "--pretty", "false"],
        { cwd: dir, encoding: "utf8" },
      );
      if (tsc.error) {
        throw tsc.error;
      }
      expect(tsc.stdout + tsc.stderr).toBe("");
      expect(tsc.status).toBe(0);
    }));
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

describe("the real src/upstream-gaps/ satisfies the scripts' contracts", () => {
  const GAPS_DIR = join(ROOT, "src", "upstream-gaps");
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
      const abs = join(ROOT, gap);
      const { GAP } = (await import(abs)) as {
        GAP: { kind: "octokit"; documentedInSpec: boolean } | { kind: "spec-only" };
      };
      const expected = GAP.kind === "octokit" && !GAP.documentedInSpec;
      expect(isSpecPinned(readFileSync(abs, "utf8"))).toBe(expected);
    }
  });

  test("every real spec-pinned gap is rewritable to the spec-only template", async () => {
    // The sweep is legitimately empty once every octokit-kind gap has graduated, so the corpus is not pinned here; the synthetic fixtures pin the
    // transform.
    for (const gap of realGapFiles) {
      const abs = join(ROOT, gap);
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

describe("indexSummary", () => {
  test.each<[count: number, tail: string]>([
    [1, "(1 gap file)"],
    [2, "(2 gap files)"],
  ])("%i gap files end the line with %s", (count, tail) => {
    expect(indexSummary(count)).toBe(`wrote src/upstream-gaps/index.ts ${tail}`);
  });
});
