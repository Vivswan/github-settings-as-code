/**
 * The public entry's pin is docs/reference/library.md: the names in the API tables under "## The API by group" are
 * exactly what src/index.ts exports, in both directions, so a name is public only once the page says what it is.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { parseSync } from "oxc-parser";
import { visitParents } from "unist-util-visit-parents";
import { ROOT } from "../root.js";

const ENTRY = "src/index.ts";
const INTERNAL_ENTRY = "src/internal.ts";
const PAGE = "docs/reference/library.md";

const API_HEADING = "## The API by group";

/** Every name an entry exports, runtime and type-only alike, sorted; a star re-export has no names to pin and is refused. */
export function exportedNames(
  entry: string,
  text = readFileSync(join(ROOT, entry), "utf8"),
): string[] {
  const { module } = parseSync(entry, text);
  return module.staticExports
    .flatMap((statement) => statement.entries)
    .map((item) => {
      if (item.exportName.kind === "None") {
        throw new Error(
          `${entry} re-exports every name of ${item.moduleRequest?.value}; list the names`,
        );
      }
      return item.exportName.name ?? "";
    })
    .sort();
}

type Root = ReturnType<typeof fromMarkdown>;
type Block = Root["children"][number];
type Table = Extract<Block, { type: "table" }>;
type TableRow = Table["children"][number];

function sourceOf(node: Block | TableRow, markdown: string): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error(`BUG: mdast-util-from-markdown left a ${node.type} node without a position`);
  }
  return markdown.slice(start, end);
}

/** The blocks under "## The API by group" up to the next second-level heading of the page's own outline; a heading inside a blockquote or a code block is content. */
function apiSection(root: Root, markdown: string): Block[] {
  const blocks = root.children;
  const start = blocks.findIndex(
    (block) =>
      block.type === "heading" && block.depth === 2 && sourceOf(block, markdown) === API_HEADING,
  );
  if (start === -1) {
    throw new Error(`${PAGE} has no "${API_HEADING}" heading`);
  }
  const rest = blocks.slice(start + 1);
  const end = rest.findIndex((block) => block.type === "heading" && block.depth === 2);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Whether `header` opens a Name table: its first cell is the plain text `Name`; the knob table's is `Knob`. */
function isNameHeader(header: TableRow | undefined): boolean {
  const cell = header?.children[0];
  const [only] = cell?.children ?? [];
  return cell?.children.length === 1 && only?.type === "text" && only.value === "Name";
}

/** The name a Name table's body row documents: its first cell as one code span; any other first cell is refused by row, so a misspelled row cannot read as absent. */
function nameOf(row: TableRow, markdown: string): string {
  const [cell] = row.children;
  const [only] = cell?.children ?? [];
  if (cell?.children.length !== 1 || only?.type !== "inlineCode") {
    throw new Error(
      `${PAGE}:${row.position?.start.line}: a Name table row must start with one code span, got: ${sourceOf(row, markdown)}`,
    );
  }
  return only.value;
}

/**
 * The names the page documents: the first column of every `| Name |` table under "## The API by group", sorted, with
 * the page parsed as GitHub renders it (a table inside a blockquote or a list item counts; one inside a fence, an
 * indented code block, or an HTML block is shown text). A duplicate row is kept, so the equality below reports it.
 */
export function documentedNames(markdown: string): string[] {
  const root = fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  const names: string[] = [];
  for (const block of apiSection(root, markdown)) {
    visitParents(block, "table", (table) => {
      const [header, ...rows] = table.children;
      if (!isNameHeader(header)) {
        return;
      }
      for (const row of rows) {
        names.push(nameOf(row, markdown));
      }
    });
  }
  return names.sort();
}

describe("the public entry", () => {
  const page = readFileSync(join(ROOT, PAGE), "utf8");
  const entry = readFileSync(join(ROOT, ENTRY), "utf8");

  test("exports exactly the names the library page's API tables document", () => {
    const exported = exportedNames(ENTRY, entry);
    // The knob table under the heading has no `| Name |` header, so an extractor reading nothing would compare two empty lists.
    expect(exported).not.toEqual([]);
    expect(exported).toEqual(documentedNames(page));
  });

  test.each([
    ["| notExported | function | Extra |", /got: \| notExported \|/],
    ["| Name | function | Extra |", /got: \| Name \|/],
  ])(
    "a Name table body row whose first cell is not one code span (%s) is refused, not skipped (negative control)",
    (row, message) => {
      const bareRow = page.replace("| `Io` | type |", `${row}\n| \`Io\` | type |`);
      expect(bareRow).not.toBe(page);
      expect(() => documentedNames(bareRow)).toThrow(message);
    },
  );

  test("a Name table after the API section is not read (negative control)", () => {
    const afterSection = `${page}\n| Name | Kind | Says |\n|---|---|---|\n| \`notExported\` | function | A table after the API section |\n`;
    expect(documentedNames(afterSection)).toEqual(documentedNames(page));
  });

  // Shown text (a fence, four-space indented code, an HTML block) renders as code or raw HTML, so a table inside it is
  // not a documented name.
  const FENCED_TABLE =
    "| Name | Kind | Says |\n|---|---|---|\n| `notExported` | function | Fenced |";
  test.each([
    ["a backtick fence", `\`\`\`md\n${FENCED_TABLE}\n\`\`\``],
    ["a tilde fence", `~~~\n${FENCED_TABLE}\n~~~`],
    ["an indented code block", FENCED_TABLE.replaceAll(/^/gm, "    ")],
    ["an HTML block", `<div>\n${FENCED_TABLE}\n</div>`],
    ["a fence whose body opens another fence", `\`\`\`md\n\`\`\`ts\n${FENCED_TABLE}\n\n\`\`\``],
    [
      "a fence inside a blockquote",
      `>   \`\`\`md\n> ${FENCED_TABLE.replaceAll("\n", "\n> ")}\n>\n>   \`\`\``,
    ],
    [
      "a fence whose body quotes a closed fence",
      `\`\`\`md\n> \`\`\`ts\n> const example = 1;\n> \`\`\`\n\n${FENCED_TABLE}\n\n\`\`\``,
    ],
  ])("%s holds shown text, not a documented name (negative control)", (_form, block) => {
    const fenced = page.replace("### Io\n", `### Io\n\n${block}\n\n`);
    expect(fenced).not.toBe(page);
    expect(documentedNames(fenced)).toEqual(documentedNames(page));
  });

  // Every table form GFM renders is read, so a row cannot escape the pin by its spelling.
  test.each([
    [
      "a row with leading whitespace",
      "| `Io` | type |",
      "  | `notExported` | function | Extra |\n| `Io` | type |",
    ],
    [
      "a row without a leading pipe",
      "| `Io` | type |",
      "`notExported` | function | Extra |\n| `Io` | type |",
    ],
    [
      "a table with a compact header",
      "### Io\n",
      "### Io\n\n|Name|Kind|Says|\n|---|---|---|\n|`notExported`|function|Extra|\n\n",
    ],
    [
      "a table whose delimiter row has no outer pipes",
      "### Io\n",
      "### Io\n\nName | Kind | Says\n--- | --- | ---\n`notExported` | function | Extra\n\n",
    ],
    [
      "a table inside a blockquote",
      "### Io\n",
      "### Io\n\n> | Name | Kind | Says |\n> |---|---|---|\n> | `notExported` | function | Quoted |\n\n",
    ],
    [
      "a table inside a nested blockquote whose markers are spaced apart",
      "### Io\n",
      "### Io\n\n>  > | Name | Kind | Says |\n>  > |---|---|---|\n>  > | `notExported` | function | Quoted |\n\n",
    ],
    [
      "a table after a quoted fence its blockquote ended without a closer",
      "### Io\n",
      "### Io\n\n> ```md\n> example\n\n| Name | Kind | Says |\n|---|---|---|\n| `notExported` | function | Extra |\n\n",
    ],
    [
      "a table after a triple-backtick inline span, which opens no fence",
      "### Io\n",
      "### Io\n\n```an inline `code` span```\n\n| Name | Kind | Says |\n|---|---|---|\n| `notExported` | function | Extra |\n\n",
    ],
    [
      "a table whose rows run into a heading, which ends the table",
      "### Io\n",
      "### Io\n\n| Name | Kind | Says |\n|---|---|---|\n| `notExported` | function | Extra |\n#### Not a row\n\n",
    ],
    [
      "a table after a quoted second-level heading, which is content and not the section's end",
      "### Io\n",
      "### Io\n\n> ## Quoted\n\n| Name | Kind | Says |\n|---|---|---|\n| `notExported` | function | Extra |\n\n",
    ],
  ])("%s is read as a documented name (negative control)", (_form, anchor, replacement) => {
    const variant = page.replace(anchor, replacement);
    expect(variant).not.toBe(page);
    expect(documentedNames(variant)).toEqual([...documentedNames(page), "notExported"].sort());
    expect(documentedNames(variant)).not.toEqual(exportedNames(ENTRY, entry));
  });

  test("a star re-export is refused, since it pins no names (negative control)", () => {
    expect(() => exportedNames(ENTRY, `${entry}export * from "./engine/outcome.js";\n`)).toThrow(
      `${ENTRY} re-exports every name of ./engine/outcome.js; list the names`,
    );
  });

  test("the two entries share no name", () => {
    const shared = exportedNames(INTERNAL_ENTRY).filter((name) =>
      exportedNames(ENTRY, entry).includes(name),
    );
    expect(shared).toEqual([]);
  });
});
