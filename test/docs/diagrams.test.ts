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
import { fencedBlocks } from "./markdown.js";

const ROOT = join(import.meta.dir, "..", "..");
const DOCS = join(ROOT, "docs");

/** The URL prefix docs/ pages use to reach a repository file (relative links may not leave docs/). */
export const REPO_FILE_URL = "https://github.com/Vivswan/github-settings-as-code/blob/main/";

/** A repo-relative path as a label token spells it: a known top-level directory, then segments. */
const PATH_TOKEN = /^(?:src|test|docs|lib|\.github)\/[\w./-]*$/;
const SYMBOL_TOKEN = /^[A-Za-z_]\w*(?:\(\))?$/;

/** Whether `file` exports `name` at its top level, under any declaration keyword. */
function exportsSymbol(file: string, name: string): boolean {
  const text = readFileSync(file, "utf8");
  return new RegExp(
    String.raw`^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+${name}\b`,
    "m",
  ).test(text);
}

/** A node definition wherever it sits: an id, an opening shape run, and what follows the run. */
const NODE_DEFINITION = /(?<![\w"-])([A-Za-z_][\w-]*)([[({>]+)(?![-|])/g;

/**
 * A mermaid block's node labels, standalone or inline on an edge line; an unquoted label is invisible to the pins, so it is reported instead of read.
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

export function labelProblems(label: string, root: string): string[] {
  const problems: string[] = [];
  const missing = new Set<string>();
  let bound: string | undefined;
  for (const segment of label.split("<br>")) {
    const tokens = segment
      .trim()
      .split(/[\s,]+/)
      .filter((token) => token !== "");
    const [head] = tokens;
    let path: string;
    let symbols: string[];
    if (head !== undefined && PATH_TOKEN.test(head)) {
      path = head;
      symbols = tokens.slice(1);
    } else if (bound !== undefined) {
      path = bound;
      symbols = tokens;
    } else {
      if (segment.includes("/") || segment.includes("()")) {
        problems.push(
          `"${label}": "${segment.trim()}" looks like code but reads as a caption; a code segment starts with a src/, test/, docs/, lib/, or .github/ path`,
        );
      }
      continue;
    }
    bound = path;
    const file = join(root, path);
    if (!existsSync(file)) {
      if (!missing.has(path)) {
        missing.add(path);
        problems.push(`"${label}": ${path} does not exist`);
      }
      continue;
    }
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
    let close = lines.indexOf("```", index + 1);
    if (close === -1) {
      close = lines.length;
    }
    const after = lines.slice(close + 1);
    const nextHeading = after.findIndex((text) => /^#{1,6}\s/.test(text));
    const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
    const demo = section.find((text) => text.startsWith("Demonstrated by:"));
    if (demo === undefined) {
      problems.push(
        `line ${index + 1}: the diagram has no "Demonstrated by:" line before the next heading`,
      );
      continue;
    }
    const links = [...demo.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] ?? "");
    if (links.length === 0) {
      problems.push(`line ${index + 1}: the "Demonstrated by:" line links nothing`);
    }
    for (const link of links) {
      if (!link.startsWith(REPO_FILE_URL)) {
        problems.push(`line ${index + 1}: "${link}" is not a ${REPO_FILE_URL} link`);
      } else if (!existsSync(join(root, link.slice(REPO_FILE_URL.length)))) {
        problems.push(`line ${index + 1}: "${link}" names a file that does not exist`);
      }
    }
  }
  return problems;
}

describe("docs/ diagrams", () => {
  const pages = readdirSync(DOCS, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .sort();

  test("the architecture page carries exactly the seven concept diagrams and the module map", () => {
    // Pinning the list means a section cannot quietly disappear while the per-page checks still pass.
    const markdown = readFileSync(join(DOCS, "reference", "architecture.md"), "utf8");
    const headings = markdown.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual([
      "## The journey of one settings file",
      "## The mental model: declare, diff, converge",
      "## The mode ladder",
      "## The layering fold as a stack",
      "## Trust and provenance",
      "## The section-module contract",
      "## The multi-repo flow",
      "## The module map",
    ]);
    expect(fencedBlocks(markdown, "mermaid")).toHaveLength(8);
    expect(markdown.split("\n").filter((line) => line.startsWith("Demonstrated by:"))).toHaveLength(
      7,
    );
  });

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

  test("accepts a real path with its exported symbols", () => {
    expect(
      diagramProblems(page("src/engine/layers.ts<br>stripNulls() mergeLayers()"), ROOT),
    ).toEqual([]);
  });

  test("accepts a caption before the path, and symbols split across segments and commas", () => {
    const label = "the fold<br>src/engine/layers.ts mergeLayers()<br>stripNulls(), Layer";
    expect(diagramProblems(page(label), ROOT)).toEqual([]);
  });

  test("reads a node defined inline on an edge line", () => {
    const markdown = `# T

\`\`\`mermaid
flowchart LR
  a["x"] -->|label| b["src/engine/nowhere.ts<br>nothing()"]
\`\`\`

${demo}
`;
    expect(diagramProblems(markdown, ROOT)).toEqual([
      '"src/engine/nowhere.ts<br>nothing()": src/engine/nowhere.ts does not exist',
    ]);
  });

  test.each<[string, string, string[]]>([
    ["a missing file", "src/engine/nowhere.ts<br>fold()", ["src/engine/nowhere.ts does not exist"]],
    [
      "an unexported symbol",
      "src/engine/layers.ts<br>foldEverything()",
      ["src/engine/layers.ts exports no foldEverything"],
    ],
    [
      "a symbol on a directory",
      "src/engine/<br>mergeLayers()",
      ["src/engine/ is a directory, so it exports no mergeLayers"],
    ],
    [
      "identifiers after a path that it does not export",
      "src/engine/layers.ts the fold",
      ["src/engine/layers.ts exports no the", "src/engine/layers.ts exports no fold"],
    ],
    [
      "a token that is neither",
      "src/engine/layers.ts mergeLayers() re-exported",
      ['"re-exported" is neither a symbol nor a path'],
    ],
    [
      "a caption after the path, which reads as symbols",
      "src/engine/layers.ts<br>low to high",
      [
        "src/engine/layers.ts exports no low",
        "src/engine/layers.ts exports no to",
        "src/engine/layers.ts exports no high",
      ],
    ],
    [
      "a type and an unexported name in a comma list",
      "src/sections/contract/module.ts<br>SectionModule, NeverExported",
      ["src/sections/contract/module.ts exports no NeverExported"],
    ],
    [
      "a mistyped path root hiding as a caption",
      "srcc/engine/layers.ts<br>nonexistent()",
      [
        '"srcc/engine/layers.ts" looks like code but reads as a caption',
        '"nonexistent()" looks like code but reads as a caption',
      ],
    ],
    [
      "a symbol list broken by punctuation",
      "src/engine/layers.ts<br>mergeLayers(); nonexistent()",
      [
        '"mergeLayers();" is neither a symbol nor a path',
        "src/engine/layers.ts exports no nonexistent",
      ],
    ],
    [
      "a lone symbol with no path to bind to",
      "the fold<br>mergeLayers()",
      ['"mergeLayers()" looks like code but reads as a caption'],
    ],
  ])("rejects %s", (_case, label, errors) => {
    const problems = diagramProblems(page(label), ROOT);
    expect(problems).toHaveLength(errors.length);
    for (const [index, error] of errors.entries()) {
      expect(problems[index]).toContain(error);
    }
  });

  test.each<[string, string]>([
    ["a round node", 'a("src/engine/layers.ts nothing()")'],
    ["a stadium node", 'a(["src/engine/layers.ts nothing()"])'],
    ["a rhombus node", 'a{"src/engine/layers.ts nothing()"}'],
    ["a flag node", 'a>"src/engine/layers.ts nothing()"]'],
  ])("reads the label of %s", (_case, node) => {
    const markdown = `# T\n\n\`\`\`mermaid\nflowchart LR\n  ${node}\n\`\`\`\n\n${demo}\n`;
    expect(diagramProblems(markdown, ROOT)).toEqual([
      '"src/engine/layers.ts nothing()": src/engine/layers.ts exports no nothing',
    ]);
  });

  test("rejects an unquoted node label", () => {
    const markdown = `# T\n\n\`\`\`mermaid\nflowchart LR\n  a[src/engine/layers.ts nothing()]\n\`\`\`\n\n${demo}\n`;
    expect(diagramProblems(markdown, ROOT)).toEqual([
      'node "a[src/engine/layers.ts nothing()]" has an unquoted label; quote it so the pins can read it',
    ]);
  });

  test("rejects a concept diagram without a demonstration line", () => {
    expect(diagramProblems(page("src/engine/layers.ts", "Some prose."), ROOT)).toEqual([
      'line 3: the diagram has no "Demonstrated by:" line before the next heading',
    ]);
  });

  test.each<[string, string, string]>([
    [
      "a relative link",
      "Demonstrated by: [x](../test/engine/layers.test.ts).",
      `is not a ${REPO_FILE_URL} link`,
    ],
    [
      "a missing file",
      `Demonstrated by: [x](${REPO_FILE_URL}test/engine/nowhere.test.ts).`,
      "names a file that does not exist",
    ],
    ["no link at all", "Demonstrated by: the layers test.", "links nothing"],
  ])("rejects a demonstration with %s", (_case, tail, error) => {
    const problems = diagramProblems(page("src/engine/layers.ts", tail), ROOT);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(error);
  });

  test("a diagram inside a generated region needs no demonstration line", () => {
    const generated = `# T\n\n## Map\n\n<!-- BEGIN GENERATED: x -->\n\`\`\`mermaid\ngraph TD\n  a["src/engine/"]\n\`\`\`\n<!-- END GENERATED: x -->\n`;
    expect(diagramProblems(generated, ROOT)).toEqual([]);
  });
});
