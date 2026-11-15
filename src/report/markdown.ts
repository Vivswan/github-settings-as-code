/**
 * Markdown building blocks shared by the private-report composer, the step summary, and the docs generators;
 * action-layer-free so the composer's independence holds.
 *
 * One renderer, two kinds of cell:
 *   step summary    -> free text the caller escapes with markdownCell(), or markdownText() outside a table; never refused
 *   generated page  -> authored prose refused rather than escaped, since an escape would change the author's text:
 *                      tableFault() before rendering
 */

import { decodeHTMLStrict } from "entities";
import {
  gfmAutolinkLiteralFromMarkdown,
  gfmAutolinkLiteralToMarkdown,
} from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import { toMarkdown } from "mdast-util-to-markdown";

/** The autolink extension's own rules for what the serializer must escape so text is not linked by accident. */
const AUTOLINK = gfmAutolinkLiteralToMarkdown();

/** Its colon rule covers a colon after `p` or `s` and before `/`; GitHub also links an uppercase scheme, so the same rule is repeated for any letter before the colon. */
const ANY_SCHEME = {
  unsafe: (AUTOLINK.unsafe ?? [])
    .filter((pattern) => pattern.character === ":")
    .map((pattern) => ({ ...pattern, before: "[A-Za-z]" })),
};

/** The GFM constructs GitHub reads beyond CommonMark that free text could open: a table cell boundary, a strikethrough, and a bare URL or address. */
const GFM = {
  extensions: [gfmTableToMarkdown(), gfmStrikethroughToMarkdown(), AUTOLINK, ANY_SCHEME],
};

/** The same, with every link in the `[text](target)` form: a table escapes a pipe as `\|`, which an angle autolink would show percent-encoded in its text. */
const GFM_PIPED = { ...GFM, resourceLink: true };

/** The grammar's own finder of the bare URLs and addresses GitHub links in text: it turns each into a link node, so the serializer writes the target whole and escapes nothing inside it. */
const LINK_BARE_URLS = gfmAutolinkLiteralFromMarkdown().transforms?.[0];

/** The content of one line of running text, as the serializer takes it. */
type Phrasing = Extract<Parameters<typeof toMarkdown>[0], { type: "paragraph" }>["children"];

/**
 * `value` as text and links: each bare URL the grammar finds is a link to itself. One holding a character
 * reference (`&amp;`) stays text, since GitHub decodes a reference inside a link target and the link would
 * point at another URL than the one written.
 */
function linked(value: string): Phrasing {
  if (LINK_BARE_URLS === undefined) {
    throw new Error(
      "BUG: mdast-util-gfm-autolink-literal exposes no transform that finds bare URLs in text",
    );
  }

  const children: Phrasing = [{ type: "text", value }];
  LINK_BARE_URLS({ type: "root", children: [{ type: "paragraph", children }] });
  return children.flatMap((node) =>
    node.type === "link" && decodeHTMLStrict(node.url) !== node.url ? node.children : [node],
  );
}

/** The serializer ends a non-empty node with one line feed; a line break in the text becomes a space first, so the text stays on its row or its line. */
function serialized(type: "tableCell" | "paragraph", text: string): string {
  const value = text.replace(/\r\n?|\n/g, " ");
  const piped = type === "tableCell" && value.includes("|");
  return toMarkdown({ type, children: linked(value) }, piped ? GFM_PIPED : GFM).replace(/\n$/, "");
}

/** `text` as the content of one table cell that renders literally: markup characters, pipes, and backslashes escaped. */
export function markdownCell(text: string): string {
  return serialized("tableCell", text);
}

/** `text` as running text outside a table that renders literally, a block opener at its start ("- ", "# ", "1. ") included. */
export function markdownText(text: string): string {
  return serialized("paragraph", text);
}

/** A URL the product built itself, as a link to exactly that URL showing the URL: never left to the reader's own autolink guess. */
export function markdownLink(url: string): string {
  const link = { type: "link" as const, url, children: [{ type: "text" as const, value: url }] };
  return toMarkdown(
    { type: "tableCell", children: [link] },
    url.includes("|") ? GFM_PIPED : GFM,
  ).replace(/\n$/, "");
}

export function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

export function renderTable(header: string, rows: ReadonlyArray<readonly string[]>): string {
  return [header, ...rows.map(tableRow)].join("\n");
}

/** Why `text` cannot be a cell of authored prose: a pipe or a line break would split its row, a blank would leave its column empty. */
export function cellFault(text: string): string | undefined {
  return text.trim() === "" || /[|\r\n]/.test(text)
    ? 'is blank or contains "|" or a line break'
    : undefined;
}

/** The cell count of a header's first line, a tableRow() line: one more pipe than cells. */
function columnsOf(header: string): number {
  return (header.split("\n")[0] ?? "").split("|").length - 2;
}

/** A settings key in a code span: the cell every registry table opens its rows with. */
const KEY_SPAN = /^`([a-z_]+)`$/;

/**
 * Which rule a table's rows pass. `cells`: every row has the header's cell count and no cell cellFault() refuses.
 * `keyed`: that, and each row opens with a key span no earlier row used, since the table walks a registry.
 */
export type TableRule = "cells" | "keyed";

/** The first row a TableRule refuses: its index among the rows, and why. */
interface RowFault {
  readonly row: number;
  readonly fault: string;
}

function rowFault(
  columns: number,
  rows: ReadonlyArray<readonly string[]>,
  rule: TableRule,
): RowFault | undefined {
  const keys = new Set<string>();
  for (const [row, cells] of rows.entries()) {
    if (cells.length !== columns) {
      return { row, fault: `has ${cells.length} cells where the table has ${columns}` };
    }
    const faulty = cells.findIndex((cell) => cellFault(cell) !== undefined);
    if (faulty !== -1) {
      return { row, fault: `cell ${faulty + 1} ${cellFault(cells[faulty] ?? "")}` };
    }
    if (rule === "keyed") {
      const key = KEY_SPAN.exec(cells[0] ?? "")?.[1];
      if (key === undefined) {
        return { row, fault: "does not open with a section key in a code span" };
      }
      if (keys.has(key)) {
        return { row, fault: `repeats the \`${key}\` row` };
      }
      keys.add(key);
    }
  }
  return undefined;
}

/**
 * The one statement of what a table under `header` may hold, naming the first faulty row: a generator throws it
 * before rendering.
 */
export function tableFault(
  header: string,
  rows: ReadonlyArray<readonly string[]>,
  rule: TableRule,
): string | undefined {
  const faulty = rowFault(columnsOf(header), rows, rule);
  if (faulty === undefined) {
    return undefined;
  }
  return `row ${faulty.row + 1} of the table ${faulty.fault}: ${tableRow(rows[faulty.row] ?? [])}`;
}
