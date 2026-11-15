import { describe, expect, test } from "bun:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { markdownCell, markdownText, renderTable } from "../../src/report/markdown.js";

/** The content of a parsed node as type and value pairs: what the GFM grammar reads, positions aside. */
function content(node: { children: ReadonlyArray<{ type: string; value?: string }> }): unknown[] {
  return node.children.map((child) => [child.type, child.value]);
}

function parse(markdown: string) {
  return fromMarkdown(markdown, {
    extensions: [gfmTable(), gfmStrikethrough()],
    mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown()],
  });
}

/** Free text that GitHub would read as markup, a second cell, or a second line. */
const HOSTILE: ReadonlyArray<readonly [what: string, text: string]> = [
  ["emphasis stars", "branches[release/*].protection: missing live, branches[feature/*] too"],
  ["strong underscores", "labels[__init__]"],
  ["raw HTML", "<img src=x> and <b>bold</b>"],
  ["a code span", "run `rm -rf` now"],
  ["a link", "[docs](https://example.com) and [ref]"],
  ["a strikethrough", "labels[~~obsolete~~]: missing live"],
  ["a pipe", "a | b"],
  ["a backslash before a pipe", "a\\|b"],
  ["a character reference", "R&D &amp; ops"],
  ["a list or heading opener", "- # 1. > not a block"],
];

describe("free text in a summary renders literally under the GFM grammar", () => {
  test.each(HOSTILE)(
    "%s in a table cell stays one cell of plain text: GitHub reads the summary with this grammar, so an unescaped character changes the rendered row",
    (_what, text) => {
      const table = parse(renderTable("| Key | Detail |\n|---|---|", [["k", markdownCell(text)]]))
        .children[0];
      const rows = table?.type === "table" ? table.children : [];

      expect(rows.map((row) => row.children.map(content))).toEqual([
        [[["text", "Key"]], [["text", "Detail"]]],
        [[["text", "k"]], [["text", text]]],
      ]);
    },
  );

  test("two detail lines joined by <br> in one cell keep their stars: before the escape, the first star of each line paired up and the text between them rendered as emphasis", () => {
    const lines = [
      "branches[release/*].protection: missing live",
      "branches[feature/*].protection: missing live",
    ];
    const table = parse(renderTable("| Detail |\n|---|", [[lines.map(markdownCell).join("<br>")]]))
      .children[0];
    const cell = table?.type === "table" ? table.children[1]?.children[0] : undefined;

    expect(cell === undefined ? [] : content(cell)).toEqual([
      ["text", lines[0]],
      ["html", "<br>"],
      ["text", lines[1]],
    ]);
  });

  test.each([
    ...HOSTILE,
    ["a list opener at the line start", "- token lacks scope"],
    ["a heading opener at the line start", "# token lacks scope"],
    ["an ordered-list opener at the line start", "1. token lacks scope"],
  ])(
    "%s on a line of its own stays one paragraph of plain text: a note is free text, and a leading marker would turn it into a list or a heading",
    (_what, text) => {
      expect(
        parse(markdownText(text)).children.map((node) => [node.type, content(node as never)]),
      ).toEqual([["paragraph", [["text", text]]]]);
    },
  );
});
