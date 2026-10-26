/**
 * Every mermaid fence in docs/ names real code; the pins prove existence only, never the claim a diagram makes.
 * A quoted node label reads per `<br>` segment, so a mistyped path or symbol cannot hide as prose:
 *   captions                -> first; may not look like code (no `/`, no `()`)
 *   a path token            -> src/, test/, docs/, lib/, or .github/ prefix
 *   symbols after the path  -> exported by that path, split on spaces and commas, in this or later segments
 * A concept diagram (outside a generated region) is followed by a "Demonstrated by:" line whose absolute GitHub links resolve to files.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../root.js";
import { fencedBlocks } from "./markdown.js";

/** The tree whose every page is under test. */
const DOCS = join(ROOT, "docs");

/** The URL prefix docs/ pages use to reach a repository file (relative links may not leave docs/). */
export const REPO_FILE_URL = "https://github.com/Vivswan/github-settings-as-code/blob/main/";

/** A repo-relative path as a label token spells it: a known top-level directory, then segments. */
const PATH_TOKEN = /^(?:src|test|docs|lib|\.github)\/[\w./-]*$/;

/** An exported symbol as a label token spells it: an identifier, with `()` allowed after a function's. */
const SYMBOL_TOKEN = /^[A-Za-z_]\w*(?:\(\))?$/;

/** Whether `file` exports `name` at its top level, under any declaration keyword. */
function exportsSymbol(file: string, name: string): boolean {
  const text = readFileSync(file, "utf8");
  return new RegExp(
    String.raw`^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+${name}\b`,
    "m",
  ).test(text);
}

const NODE_DEFINITION = /(?<![\w"-])([A-Za-z_][\w-]*)([[({>]+)(?![-|])/g;

/**
 * A mermaid block's node labels, standalone or inline on an edge line; an unquoted label is invisible to the pins,
 * so it is reported instead of read.
 */
function nodeLabels(mermaid: string): { labels: string[]; problems: string[] } {
  const labels: string[] = [];
  const problems: string[] = [];
  const reportedLines = new Set<number>();
  const body = mermaid.split("\n").slice(1).join("\n"); // the first line is the diagram kind
  // A `(` or `[` inside a quoted label (`mergeLayers()`) is label text, not a node opener.
  const quotedSpans = [...body.matchAll(/"[^"]*"/g)].map(
    (span) => [span.index, span.index + span[0].length] as const,
  );
  for (const match of body.matchAll(NODE_DEFINITION)) {
    if (quotedSpans.some(([start, end]) => match.index > start && match.index < end)) {
      continue;
    }
    const rest = body.slice(match.index + match[0].length);
    const quoted = rest.match(/^"([^"]*)"[\])}]+/);
    if (quoted === null) {
      const lineStart = body.lastIndexOf("\n", match.index) + 1;
      if (!reportedLines.has(lineStart)) {
        reportedLines.add(lineStart);
        const line = body.slice(lineStart).split("\n")[0] ?? "";
        problems.push(
          `node "${line.trim()}" has an unquoted label; quote it so the pins can read it`,
        );
      }
      continue;
    }
    labels.push(quoted[1] ?? "");
  }
  return { labels, problems };
}

/** A segment's code reading: the path it opens with, or the one an earlier segment bound, and the symbols after it; null for a caption. */
function codeSegment(
  tokens: readonly string[],
  bound: string | undefined,
): { path: string; symbols: readonly string[] } | null {
  const [head] = tokens;
  if (head !== undefined && PATH_TOKEN.test(head)) {
    return { path: head, symbols: tokens.slice(1) };
  }
  if (bound === undefined) {
    return null;
  }
  return { path: bound, symbols: tokens };
}

/** The problems of the symbols a segment lists after `path`, whose file exists at `file`. */
function symbolProblems(
  label: string,
  path: string,
  file: string,
  symbols: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const symbol of symbols) {
    if (!SYMBOL_TOKEN.test(symbol)) {
      problems.push(
        `"${label}": "${symbol}" is neither a symbol nor a path; after a path, a label lists only exported symbols`,
      );
      continue;
    }
    const name = symbol.replace(/\(\)$/, "");
    if (path.endsWith("/")) {
      problems.push(`"${label}": ${path} is a directory, so it exports no ${name}`);
    } else if (!exportsSymbol(file, name)) {
      problems.push(`"${label}": ${path} exports no ${name}`);
    }
  }
  return problems;
}

export function labelProblems(label: string, root: string): string[] {
  const problems: string[] = [];
  const missing = new Set<string>();
  let bound: string | undefined;
  for (const segment of label.split("<br>")) {
    const tokens = segment
      .trim()
      .split(/[\s,]+/)
      .filter((token) => token !== "");
    const code = codeSegment(tokens, bound);
    if (code === null) {
      if (segment.includes("/") || segment.includes("()")) {
        problems.push(
          `"${label}": "${segment.trim()}" looks like code but reads as a caption; a code segment starts with a src/, test/, docs/, lib/, or .github/ path`,
        );
      }
      continue;
    }
    bound = code.path;
    const file = join(root, code.path);
    if (!existsSync(file)) {
      if (!missing.has(code.path)) {
        missing.add(code.path);
        problems.push(`"${label}": ${code.path} does not exist`);
      }
      continue;
    }
    problems.push(...symbolProblems(label, code.path, file, code.symbols));
  }
  return problems;
}

/** Whether the fence opening at `line` sits inside a generated region. */
function insideGeneratedRegion(lines: readonly string[], line: number): boolean {
  let open = false;
  for (const [index, text] of lines.entries()) {
    if (index === line) {
      return open;
    }
    if (/^<!-- BEGIN GENERATED: /.test(text)) {
      open = true;
    } else if (/^<!-- END GENERATED: /.test(text)) {
      open = false;
    }
  }
  return open;
}

/** The problems of the "Demonstrated by:" line the concept diagram opening at `index` needs before the next heading. */
function demonstrationProblems(lines: readonly string[], index: number, root: string): string[] {
  const fenceEnd = lines.indexOf("```", index + 1);
  const close = fenceEnd === -1 ? lines.length : fenceEnd;
  const after = lines.slice(close + 1);
  const nextHeading = after.findIndex((text) => /^#{1,6}\s/.test(text));
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
  const demo = section.find((text) => text.startsWith("Demonstrated by:"));
  if (demo === undefined) {
    return [
      `line ${index + 1}: the diagram has no "Demonstrated by:" line before the next heading`,
    ];
  }
  const links = [...demo.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] ?? "");
  if (links.length === 0) {
    return [`line ${index + 1}: the "Demonstrated by:" line links nothing`];
  }
  const problems: string[] = [];
  for (const link of links) {
    if (!link.startsWith(REPO_FILE_URL)) {
      problems.push(`line ${index + 1}: "${link}" is not a ${REPO_FILE_URL} link`);
    } else if (!existsSync(join(root, link.slice(REPO_FILE_URL.length)))) {
      problems.push(`line ${index + 1}: "${link}" names a file that does not exist`);
    }
  }
  return problems;
}

export function diagramProblems(markdown: string, root: string): string[] {
  const problems: string[] = [];
  for (const block of fencedBlocks(markdown, "mermaid")) {
    const nodes = nodeLabels(block);
    problems.push(...nodes.problems);
    for (const label of nodes.labels) {
      problems.push(...labelProblems(label, root));
    }
  }
  const lines = markdown.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line !== "```mermaid" || insideGeneratedRegion(lines, index)) {
      continue;
    }
    problems.push(...demonstrationProblems(lines, index, root));
  }
  return problems;
}

describe("docs/ diagrams", () => {
  const pages = readdirSync(DOCS, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .sort();

  for (const page of pages) {
    test(`docs/${page}: every diagram names real code and links its demonstration`, () => {
      expect(diagramProblems(readFileSync(join(DOCS, page), "utf8"), ROOT)).toEqual([]);
    });
  }
});

describe("diagram guard (mutation checks)", () => {
  const demo = `Demonstrated by: [x](${REPO_FILE_URL}test/engine/layers.test.ts).`;
  const page = (label: string, tail = demo): string =>
    `# T\n\n\`\`\`mermaid\nflowchart LR\n  a["${label}"]\n\`\`\`\n\n${tail}\n\n## Next\n`;
  /** A flowchart whose body is `body` (one or more node definitions), followed by the demonstration line. */
  const flowchart = (body: string): string =>
    `# T\n\n\`\`\`mermaid\nflowchart LR\n  ${body}\n\`\`\`\n\n${demo}\n`;
  const CAPTION_TAIL =
    "looks like code but reads as a caption; a code segment starts with a src/, test/, docs/, lib/, or .github/ path";
  const NEITHER_TAIL =
    "is neither a symbol nor a path; after a path, a label lists only exported symbols";

  // Every problem a page can raise, whole: the label (or the line) it names, then the message; an accepted page raises none.
  test.each<[name: string, markdown: string, problems: string[]]>([
    [
      "a real path with its exported symbols",
      page("src/engine/layers.ts<br>standaloneView() mergeLayers()"),
      [],
    ],
    [
      "a caption before the path, and symbols split across segments and commas",
      page("the fold<br>src/engine/layers.ts mergeLayers()<br>standaloneView(), Layer"),
      [],
    ],
    [
      "a diagram inside a generated region, which needs no demonstration line",
      `# T\n\n## Map\n\n<!-- BEGIN GENERATED: x -->\n\`\`\`mermaid\ngraph TD\n  a["src/engine/"]\n\`\`\`\n<!-- END GENERATED: x -->\n`,
      [],
    ],
    [
      "a node defined inline on an edge line",
      flowchart('a["x"] -->|label| b["src/engine/nowhere.ts<br>nothing()"]'),
      ['"src/engine/nowhere.ts<br>nothing()": src/engine/nowhere.ts does not exist'],
    ],
    [
      "a missing file",
      page("src/engine/nowhere.ts<br>fold()"),
      ['"src/engine/nowhere.ts<br>fold()": src/engine/nowhere.ts does not exist'],
    ],
    [
      "an unexported symbol",
      page("src/engine/layers.ts<br>foldEverything()"),
      [
        '"src/engine/layers.ts<br>foldEverything()": src/engine/layers.ts exports no foldEverything',
      ],
    ],
    [
      "a symbol on a directory",
      page("src/engine/<br>mergeLayers()"),
      ['"src/engine/<br>mergeLayers()": src/engine/ is a directory, so it exports no mergeLayers'],
    ],
    [
      "identifiers after a path that it does not export",
      page("src/engine/layers.ts the fold"),
      [
        '"src/engine/layers.ts the fold": src/engine/layers.ts exports no the',
        '"src/engine/layers.ts the fold": src/engine/layers.ts exports no fold',
      ],
    ],
    [
      "a token that is neither",
      page("src/engine/layers.ts mergeLayers() re-exported"),
      [`"src/engine/layers.ts mergeLayers() re-exported": "re-exported" ${NEITHER_TAIL}`],
    ],
    [
      "a caption after the path, which reads as symbols",
      page("src/engine/layers.ts<br>low to high"),
      [
        '"src/engine/layers.ts<br>low to high": src/engine/layers.ts exports no low',
        '"src/engine/layers.ts<br>low to high": src/engine/layers.ts exports no to',
        '"src/engine/layers.ts<br>low to high": src/engine/layers.ts exports no high',
      ],
    ],
    [
      "a type and an unexported name in a comma list",
      page("src/sections/contract/module.ts<br>SectionModule, NeverExported"),
      [
        '"src/sections/contract/module.ts<br>SectionModule, NeverExported": src/sections/contract/module.ts exports no NeverExported',
      ],
    ],
    [
      "a mistyped path root hiding as a caption",
      page("srcc/engine/layers.ts<br>nonexistent()"),
      [
        `"srcc/engine/layers.ts<br>nonexistent()": "srcc/engine/layers.ts" ${CAPTION_TAIL}`,
        `"srcc/engine/layers.ts<br>nonexistent()": "nonexistent()" ${CAPTION_TAIL}`,
      ],
    ],
    [
      "a symbol list broken by punctuation",
      page("src/engine/layers.ts<br>mergeLayers(); nonexistent()"),
      [
        `"src/engine/layers.ts<br>mergeLayers(); nonexistent()": "mergeLayers();" ${NEITHER_TAIL}`,
        '"src/engine/layers.ts<br>mergeLayers(); nonexistent()": src/engine/layers.ts exports no nonexistent',
      ],
    ],
    [
      "a lone symbol with no path to bind to",
      page("the fold<br>mergeLayers()"),
      [`"the fold<br>mergeLayers()": "mergeLayers()" ${CAPTION_TAIL}`],
    ],
    // Every node shape with a quoted label reads the same way.
    [
      "a round node",
      flowchart('a("src/engine/layers.ts nothing()")'),
      ['"src/engine/layers.ts nothing()": src/engine/layers.ts exports no nothing'],
    ],
    [
      "a stadium node",
      flowchart('a(["src/engine/layers.ts nothing()"])'),
      ['"src/engine/layers.ts nothing()": src/engine/layers.ts exports no nothing'],
    ],
    [
      "a rhombus node",
      flowchart('a{"src/engine/layers.ts nothing()"}'),
      ['"src/engine/layers.ts nothing()": src/engine/layers.ts exports no nothing'],
    ],
    [
      "a flag node",
      flowchart('a>"src/engine/layers.ts nothing()"]'),
      ['"src/engine/layers.ts nothing()": src/engine/layers.ts exports no nothing'],
    ],
    [
      "an unquoted node label",
      flowchart("a[src/engine/layers.ts nothing()]"),
      [
        'node "a[src/engine/layers.ts nothing()]" has an unquoted label; quote it so the pins can read it',
      ],
    ],
    // The demonstration line a concept diagram needs, absent or malformed.
    [
      "a concept diagram with no demonstration line",
      page("src/engine/layers.ts", "Some prose."),
      ['line 3: the diagram has no "Demonstrated by:" line before the next heading'],
    ],
    [
      "a concept diagram with a relative demonstration link",
      page("src/engine/layers.ts", "Demonstrated by: [x](../test/engine/layers.test.ts)."),
      [`line 3: "../test/engine/layers.test.ts" is not a ${REPO_FILE_URL} link`],
    ],
    [
      "a concept diagram with a demonstration link to a missing file",
      page(
        "src/engine/layers.ts",
        `Demonstrated by: [x](${REPO_FILE_URL}test/engine/nowhere.test.ts).`,
      ),
      [`line 3: "${REPO_FILE_URL}test/engine/nowhere.test.ts" names a file that does not exist`],
    ],
    [
      "a concept diagram with a demonstration line linking nothing",
      page("src/engine/layers.ts", "Demonstrated by: the layers test."),
      ['line 3: the "Demonstrated by:" line links nothing'],
    ],
  ])("%s", (_name, markdown, problems) => {
    expect(diagramProblems(markdown, ROOT)).toEqual(problems);
  });
});
