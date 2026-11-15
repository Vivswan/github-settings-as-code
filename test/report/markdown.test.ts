/**
 * The grammar used to read the output back is micromark's, which differs from GitHub's cmark-gfm on two points:
 * it does not decode a character reference inside an angle autolink's target, and its bare-URL reader runs on the
 * text after unescaping, so it links a URL whose colon is escaped where GitHub leaves it plain. The rows for a
 * URL that must come out unlinked therefore assert the emitted text, not the parsed tree.
 */

import { describe, expect, test } from "bun:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { toString as nodeText } from "mdast-util-to-string";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { visitParents } from "unist-util-visit-parents";
import { markdownCell, markdownText, renderTable } from "../../src/report/markdown.js";

/** The content of a parsed node as type and value pairs: what the GFM grammar reads, positions aside. */
function content(node: { children: ReadonlyArray<{ type: string; value?: string }> }): unknown[] {
  return node.children.map((child) => [child.type, child.value]);
}

function parse(markdown: string) {
  return fromMarkdown(markdown, {
    extensions: [gfmTable(), gfmStrikethrough(), gfmAutolinkLiteral()],
    mdastExtensions: [
      gfmTableFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      gfmAutolinkLiteralFromMarkdown(),
    ],
  });
}

/** What a parsed node renders as: its text, and every kind of child that is neither text nor a link (a link shows its own text). */
function rendered(node: { children: ReadonlyArray<{ type: string }> }): unknown {
  const marks = node.children
    .map((child) => child.type)
    .filter((type) => type !== "text" && type !== "link");
  return { text: nodeText(node), marks };
}

/** Every link target under a tree, in order. */
function hrefs(tree: ReturnType<typeof parse>): string[] {
  const found: string[] = [];
  visitParents(tree, "link", (link) => {
    found.push(link.url);
  });
  return found;
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

      expect(rows.map((row) => row.children.map(rendered))).toEqual([
        [
          { text: "Key", marks: [] },
          { text: "Detail", marks: [] },
        ],
        [
          { text: "k", marks: [] },
          { text, marks: [] },
        ],
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
        parse(markdownText(text)).children.map((node) => [node.type, rendered(node as never)]),
      ).toEqual([["paragraph", { text, marks: [] }]]);
    },
  );

  test.each([
    ["a query string", "https://example.com/hook?a=1&b=2", "https://example.com/hook?a=1&b=2"],
    [
      "a path with underscores at word edges",
      "https://github.com/acme/_admin_/actions/runs/1",
      "https://github.com/acme/_admin_/actions/runs/1",
    ],
    ["a bare www address", "www.example.com/a_b_", "http://www.example.com/a_b_"],
    [
      "a pipe, which a table cell must escape",
      "https://example.com/hook?branches=main|release",
      "https://example.com/hook?branches=main|release",
    ],
  ])(
    "a bare URL with %s links to exactly itself: GitHub's autolink keeps a backslash escape inside a URL, so an escaped one shows the backslash and points elsewhere",
    (_what, text, href) => {
      const cell = parse(renderTable("| Detail |\n|---|", [[markdownCell(`see ${text} now`)]]));
      const line = parse(markdownText(`see ${text} now`));

      expect([hrefs(cell), nodeText(cell.children[0]), hrefs(line), nodeText(line)]).toEqual([
        [href],
        `Detailsee ${text} now`,
        [href],
        `see ${text} now`,
      ]);
    },
  );

  test.each([
    [
      "a named character reference in a URL",
      "see https://example.com/hook?a=1&amp;b=2 now",
      "see https\\://example.com/hook?a=1\\&amp;b=2 now",
    ],
    [
      "a numeric character reference in a URL",
      "https://example.com/hook?x=&#124;y",
      "https\\://example.com/hook?x=\\&#124;y",
    ],
    [
      "a numeric character reference padded past the CommonMark digit limit, which GitHub still decodes",
      "https://example.com/hook?x=&#00000124;y",
      "https\\://example.com/hook?x=\\&#00000124;y",
    ],
    [
      "an uppercase scheme and a host without a dot",
      "HTTPS://localhost/_admin_/end",
      "HTTPS\\://localhost/\\_admin\\_/end",
    ],
    [
      "an uppercase scheme with a port and brackets",
      "HTTP://localhost:8080/hook?x=[1]",
      "HTTP\\://localhost:8080/hook?x=\\[1]",
    ],
  ])(
    "%s is written unlinkable: GitHub decodes a reference inside a link target and keeps a backslash inside a URL it links itself, so either would point somewhere the text does not say",
    (_what, text, emitted) => {
      expect([markdownCell(text), markdownText(text)]).toEqual([emitted, emitted]);
    },
  );
});
