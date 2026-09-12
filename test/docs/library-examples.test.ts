/**
 * The library page's `ts` fences are one program: compiled in page order
 * against src/index.ts under the repository's tsconfig, so an example that
 * drifts from a signature fails here, named by its page line, instead of on
 * a reader's machine. Two hand-repaired stale signatures on the page are the
 * inputs that motivated this.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const PAGE = "docs/reference/library.md";
const PACKAGE = "@vivswan/github-settings-as-code";

/** Where the package's two import paths land when the fences compile against this checkout. */
const ENTRY = join(ROOT, "src", "index.js");
const SCHEMA = join(ROOT, "lib", "settings.schema.json");

/** One `ts` fence: its body and the page line (1-based) of the body's first line. */
interface Fence {
  readonly line: number;
  readonly body: string;
}

/**
 * The `ts` fences of a page, in order. Fences are column-zero triple backticks
 * (guides.test.ts enforces that) and its policy reads the info string with
 * trailing whitespace trimmed, so "```ts " is a ts fence here too.
 */
export function tsFences(markdown: string): Fence[] {
  const fences: Fence[] = [];
  let open: { info: string; line: number; lines: string[] } | null = null;
  for (const [index, text] of markdown.split("\n").entries()) {
    if (open === null) {
      if (text.startsWith("```")) {
        open = { info: text.slice(3).trimEnd(), line: index + 2, lines: [] };
      }
    } else if (text === "```") {
      if (open.info === "ts") {
        fences.push({ line: open.line, body: open.lines.join("\n") });
      }
      open = null;
    } else {
      open.lines.push(text);
    }
  }
  return fences;
}

/**
 * The fences as one module: only the two package paths are rewritten, on the
 * lines they already occupy, so a program line is a page line by offset alone
 * and nothing else about a fence is repaired before tsc sees it. The page
 * imports each name once, in the first example that uses it.
 */
export function examplesProgram(fences: readonly Fence[]): {
  text: string;
  pageLine: (programLine: number) => number;
} {
  const starts: number[] = [];
  const parts: string[] = [];
  let line = 1;
  for (const fence of fences) {
    starts.push(line);
    const body = fence.body
      .replaceAll(`"${PACKAGE}/settings.schema.json"`, JSON.stringify(SCHEMA))
      .replaceAll(`"${PACKAGE}"`, JSON.stringify(ENTRY));
    parts.push(body);
    line += body.split("\n").length;
  }
  return {
    text: parts.join("\n"),
    pageLine: (programLine) => {
      let index = starts.length - 1;
      while (index >= 0 && (starts[index] ?? 0) > programLine) {
        index--;
      }
      const fence = fences[index];
      const start = starts[index];
      if (fence === undefined || start === undefined) {
        throw new Error(`program line ${programLine} lies in no fence`);
      }
      return fence.line + (programLine - start);
    },
  };
}

/** `tsc --pretty false` prints `<file>(<line>,<col>): error TS<code>: <message>`, continuation lines indented. */
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * Every diagnostic tsc reports for the page's fences, as `<label>:<page line>: TS<code>: <message>`.
 * A diagnostic outside the examples file keeps its own path. The compile runs in a temp project
 * that symlinks this checkout's node_modules, so `types` and the runtime dependencies resolve
 * exactly as they do for src/; the project is removed on every path.
 */
export function compileExamples(markdown: string, label: string): string[] {
  const fences = tsFences(markdown);
  const { text, pageLine } = examplesProgram(fences);
  const dir = mkdtempSync(join(tmpdir(), "gsac-library-examples-"));
  try {
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    const examples = join(dir, "examples.ts");
    writeFileSync(examples, text);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: join(ROOT, "tsconfig.json"),
        compilerOptions: { noEmit: true, resolveJsonModule: true },
        // src/'s ambient declarations (bottleneck/light.js) ride along, as they do under the base config.
        include: [join(ROOT, "src", "**", "*.d.ts")],
        files: ["examples.ts"],
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
    const problems: string[] = [];
    for (const raw of tsc.stdout.split("\n")) {
      const match = raw.match(DIAGNOSTIC);
      if (match) {
        const [, printed = "", line = "0", column = "0", code = "", message = ""] = match;
        // tsc prints paths relative to its cwd, the temp project.
        const file = resolve(dir, printed);
        problems.push(
          file === examples
            ? `${label}:${pageLine(Number(line))}: ${code}: ${message}`
            : `${file}(${line},${column}): ${code}: ${message}`,
        );
      } else if (raw.startsWith("  ") && problems.length > 0) {
        problems[problems.length - 1] += `\n${raw}`;
      }
    }
    // tsc exits 0 only on a clean compile; a non-zero exit with no parsed diagnostic is tooling
    // trouble (a crash, a changed output format) and must never read as a clean page.
    if ((tsc.status !== 0) !== problems.length > 0) {
      throw new Error(
        `tsc exited ${tsc.status} with ${problems.length} diagnostics:\n${tsc.stdout}\n${tsc.stderr}`,
      );
    }
    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe(`${PAGE} examples`, () => {
  test("every ts fence compiles, in page order, against src/index.ts", () => {
    const markdown = readFileSync(join(ROOT, PAGE), "utf8");
    // A page with no fences would compile an empty program; the guard exists for the examples.
    expect(tsFences(markdown).length).toBeGreaterThan(0);
    expect(compileExamples(markdown, PAGE)).toEqual([]);
  });

  // Each fence is one slip the page could ship; the pinned list is what tsc must say about it,
  // by page line. A syntax slip stops tsc before its semantic pass, so it is its own case.
  const semanticSlips = [
    "# Page",
    "",
    "```ts",
    'import { describeProblem, parseRepoSlug } from "@vivswan/github-settings-as-code";',
    "",
    'const repo = parseRepoSlug("octo-org/api");',
    "```",
    "",
    "Prose between the fences.",
    "",
    "```ts ",
    'import { SECTION_KEYS } from "@vivswan/github-settings-as-code";',
    "",
    "console.log(repo.value, SECTION_KEYS.length, describeProblem, describeProblem_2);",
    "```",
    "",
    "```ts",
    'import { missingExport as parseRepoSlug } from "@vivswan/github-settings-as-code";',
    "```",
    "",
    "```ts",
    "import {",
    "  parseRepoSlug as",
    "    parse,",
    "  type SectionKey",
    '} from "@vivswan/github-settings-as-code";',
    "",
    'const key: SectionKey = parse("a/b");',
    "```",
    "",
  ];
  const syntaxSlip = [
    "```ts",
    'import { describeProblem,, SECTION_KEYS } from "@vivswan/github-settings-as-code";',
    "```",
    "",
  ];
  const doubledName = [
    "```ts",
    'import { describeProblem, describeProblem } from "@vivswan/github-settings-as-code";',
    "```",
    "",
  ];
  test.each<[string, string[], string[]]>([
    [
      "a .value read off a Result, an undeclared name, a missing export aliased onto an imported name, a multi-line import",
      semanticSlips,
      [
        "page.md:4: TS2300",
        "page.md:14: TS2339",
        "page.md:14: TS2552",
        "page.md:18: TS2300",
        "page.md:18: TS2305",
        "page.md:28: TS2322",
      ],
    ],
    ["a doubled comma in an import", syntaxSlip, ["page.md:2: TS1003"]],
    ["a name imported twice", doubledName, ["page.md:2: TS2300", "page.md:2: TS2300"]],
  ])("%s fails with the page line and the TypeScript code", (_slips, lines, expected) => {
    const problems = compileExamples(lines.join("\n"), "page.md");
    expect(problems.map((problem) => problem.split(": ").slice(0, 2).join(": ")).sort()).toEqual(
      expected.sort(),
    );
  });

  test("the .value read is reported as the property TypeScript cannot find on the Result", () => {
    const problems = compileExamples(semanticSlips.join("\n"), "page.md");
    expect(problems.find((problem) => problem.startsWith("page.md:14: TS2339"))).toMatch(
      /TS2339: Property 'value' does not exist on type 'Result</,
    );
  });
});
