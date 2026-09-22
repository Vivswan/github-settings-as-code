import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  camelCaseGapName,
  gapFileBases,
  generateIndex,
} from "../../.github/scripts/gen-gaps-index.js";
import {
  type Diagnostic,
  isGapFile,
  isSpecOnly,
  isSpecPinned,
  parseDiagnostics,
  planGraduation,
  toSpecOnlyGapSource,
} from "../../.github/scripts/graduate-upstream-gaps.js";
import type { UnshippedGraphqlSdl } from "../../src/upstream-gaps/gap.js";
import { ROOT } from "../root.js";
import { withTempDir } from "../temp-dir.js";

const TRIPWIRE_MESSAGE =
  "Type '\"GET /repos/{owner}/{repo}/merge-queue\"' does not satisfy the constraint 'never'.";

describe("parseDiagnostics", () => {
  test.each<[label: string, output: string, diagnostics: Diagnostic[]]>([
    [
      "--pretty false diagnostic lines",
      [
        `src/upstream-gaps/merge-queue.ts(12,34): error TS2344: ${TRIPWIRE_MESSAGE}`,
        "src/engine/diff.ts(7,3): error TS2322: Type 'string' is not assignable to type 'number'.",
        "",
      ].join("\n"),
      [
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
      ],
    ],
    [
      "CRLF line endings",
      "src/upstream-gaps/a.ts(1,1): error TS2344: boom\r\n",
      [{ file: "src/upstream-gaps/a.ts", line: 1, column: 1, code: 2344, message: "boom" }],
    ],
  ])("parses %s", (_label, output, expected) => {
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(unparsed).toEqual([]);
    expect(diagnostics).toEqual(expected);
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
  // Only a .ts file directly under src/upstream-gaps/ is a gap. index.ts and gap.ts carry no tripwire; a TS2344 in
  // either means the machinery broke, and deleting it could never be the fix. Declaration and test strays are not gaps.
  test.each<[path: string, gap: boolean]>([
    ["src/upstream-gaps/merge-queue.ts", true],
    ["src/upstream-gaps/nested/deep.ts", false],
    ["src/sections/labels.ts", false],
    ["src/upstream-gaps.ts", false],
    ["src/upstream-gaps/index.ts", false],
    ["src/upstream-gaps/gap.ts", false],
    ["src/upstream-gaps/notes.d.ts", false],
    ["src/upstream-gaps/scratch.test.ts", false],
  ])("%s is a gap file: %p", (path, gap) => {
    expect(isGapFile(path)).toBe(gap);
  });
});

describe("planGraduation", () => {
  const MERGE_QUEUE = "src/upstream-gaps/merge-queue.ts";
  const PAGES_HTTPS = "src/upstream-gaps/pages-https.ts";
  const tripwire = (file: string): Diagnostic => ({
    file,
    line: 10,
    column: 20,
    code: 2344,
    message: TRIPWIRE_MESSAGE,
  });
  const at = (file: string, code: number, message: string): Diagnostic => ({
    file,
    line: 1,
    column: 1,
    code,
    message,
  });
  const typeError = at(MERGE_QUEUE, 2322, "Type 'string' is not assignable to type 'number'.");
  const noiseIn = (file: string): Diagnostic => at(file, 2344, "tripwire-shaped noise");

  test.each<[label: string, diagnostics: Diagnostic[], gapFiles: string[], foreign: Diagnostic[]]>([
    [
      "tripped gap files are collected, deduplicated and sorted",
      [tripwire(PAGES_HTTPS), tripwire(MERGE_QUEUE), tripwire(MERGE_QUEUE)],
      [MERGE_QUEUE, PAGES_HTTPS],
      [],
    ],
    ["a non-2344 error inside a gap file is foreign", [typeError], [], [typeError]],
    [
      "one foreign diagnostic does not hide the graduatable ones",
      [tripwire(MERGE_QUEUE), tripwire("src/engine/diff.ts")],
      [MERGE_QUEUE],
      [tripwire("src/engine/diff.ts")],
    ],
    // index.ts and gap.ts carry no tripwire; a TS2344 in either means the machinery broke, and deleting it could
    // never be the fix.
    [
      "a tripwire-shaped error in index.ts is foreign",
      [noiseIn("src/upstream-gaps/index.ts")],
      [],
      [noiseIn("src/upstream-gaps/index.ts")],
    ],
    [
      "a tripwire-shaped error in gap.ts is foreign",
      [noiseIn("src/upstream-gaps/gap.ts")],
      [],
      [noiseIn("src/upstream-gaps/gap.ts")],
    ],
  ])("%s", (_label, diagnostics, gapFiles, foreign) => {
    expect(planGraduation(diagnostics)).toEqual({ gapFiles, foreign });
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
  test.each<[label: string, listing: string[], bases: string[]]>([
    [
      "only gap .ts files, stripped and sorted",
      ["pages-https.ts", "index.ts", "gap.ts", "merge-queue.ts", "README.md"],
      ["merge-queue", "pages-https"],
    ],
    [
      "no declaration or test stray as a phantom gap",
      ["notes.d.ts", "scratch.test.ts", "merge-queue.ts"],
      ["merge-queue"],
    ],
  ])("keeps %s", (_label, listing, bases) => {
    expect(gapFileBases(listing)).toEqual(bases);
  });
});

describe("generateIndex", () => {
  const GAPS_DIR = join(ROOT, "src", "upstream-gaps");
  const realBases = gapFileBases(readdirSync(GAPS_DIR));

  test.each<[label: string, bases: string[]]>([
    ["an empty directory", []],
    ["the real gap directory", realBases],
  ])(
    "the index generated for %s type-checks beside its gap files, loads, and its SDL entries name them",
    (_label, bases) =>
      withTempDir("gaps-index-", async (dir) => {
        // A src/ mirror: every sibling of upstream-gaps/ symlinked (a gap may import ../types.js), the gap files
        // copied beside the generated index. The empty row matters on its own: the committed index compiles under
        // the project typecheck only while a gap file exists, so a derivation written for a populated GAPS (say
        // `(typeof GAPS)["lfs"]`) would first break the day the last gap graduates.
        const gapsDir = join(dir, "src", "upstream-gaps");
        mkdirSync(gapsDir, { recursive: true });
        symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
        for (const entry of readdirSync(join(ROOT, "src"))) {
          if (entry !== "upstream-gaps") {
            symlinkSync(join(ROOT, "src", entry), join(dir, "src", entry));
          }
        }
        for (const file of ["gap", ...bases]) {
          copyFileSync(join(GAPS_DIR, `${file}.ts`), join(gapsDir, `${file}.ts`));
        }
        writeFileSync(join(gapsDir, "index.ts"), generateIndex(bases));
        writeFileSync(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            extends: join(ROOT, "tsconfig.json"),
            include: [],
            files: ["src/upstream-gaps/index.ts"],
          }),
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
        // Loading resolves every import. The GAPS key, not the import, is what names a gap file downstream:
        // unshippedGraphqlSdl() renders it as the file to retire, and a camelCase key would compile yet name a
        // file that does not exist.
        const { UNSHIPPED_GRAPHQL_SDL } = (await import(join(gapsDir, "index.ts"))) as {
          UNSHIPPED_GRAPHQL_SDL: readonly UnshippedGraphqlSdl[];
        };
        const unresolved = UNSHIPPED_GRAPHQL_SDL.map((entry) => entry.file).filter(
          (file) => !existsSync(join(ROOT, file)),
        );
        expect(unresolved).toEqual([]);
      }),
  );
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

  test.each<[label: string, source: string, error: RegExp]>([
    [
      "a source without the defineGap shape, naming the file",
      "export const GAP = 42;",
      /merge-queue\.ts does not match the documented defineGap shape/,
    ],
    [
      "a defineGap without parsable routes",
      [
        "/** doc */",
        "export const GAP = defineGap({",
        "  routes: [],",
        "  documentedInSpec: false,",
        "});",
      ].join("\n"),
      /no parsable routes/,
    ],
    [
      "non-literal routes-array content, not silently dropped",
      SOURCE.replace('"GET /repos/{owner}/{repo}/merge-queue",', "LIST_ROUTE,"),
      /more than plain string literals.*LIST_ROUTE/,
    ],
    [
      "a commented-out route in the array, not resurrected",
      SOURCE.replace(
        '"GET /repos/{owner}/{repo}/merge-queue",',
        '// dropped: "GET /repos/{owner}/{repo}/old"',
      ),
      /more than plain string literals/,
    ],
  ])("refuses %s loudly", (_label, source, error) => {
    expect(() => toSpecOnlyGapSource(source, GAP_FILE)).toThrow(error);
  });
});

describe("the real src/upstream-gaps/ satisfies the scripts' contracts", () => {
  const GAPS_DIR = join(ROOT, "src", "upstream-gaps");
  const realGapFiles = readdirSync(GAPS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/upstream-gaps/${f}`)
    .filter((f) => isGapFile(f));

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
