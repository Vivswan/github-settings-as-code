import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { visitParents } from "unist-util-visit-parents";

/** The syntax tree of a CommonMark document with GFM tables, every node carrying its source position. */
export function markdownTree(markdown: string): ReturnType<typeof fromMarkdown> {
  return fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
}

/** One fenced code block, as the syntax tree reads it. */
export interface CodeFence {
  /** The info string's first word, "" when the fence has none. */
  readonly lang: string;

  /** The info string: the language word, then one space and the rest as written when there is more. */
  readonly info: string;

  /** The block's text, with the indent and the markers of the list item or blockquote around it removed. */
  readonly body: string;

  /** The opening fence's line, 1-based. */
  readonly line: number;

  /** The opening fence's whole source line. */
  readonly opener: string;

  /** The closing fence's whole source line; null when the document or the container ends first. */
  readonly closer: string | null;

  /** The closing fence's line, 1-based, or the block's last line when it has none. */
  readonly endLine: number;

  /** Whether the fence sits in a list item, a blockquote, or any other container. */
  readonly nested: boolean;
}

/** Every fenced code block of `markdown`, in order; an indented code block has no fence and is left out. */
export function codeFences(markdown: string): CodeFence[] {
  // The parser's own fence tokens say where a block opens and whether it closes; the finished tree keeps neither.
  const fenceLines = new Map<object, number[]>();
  const tree = fromMarkdown(markdown, {
    mdastExtensions: [
      {
        enter: {
          codeFencedFence(token) {
            // The closing fence arrives while the block's text is still buffering above its node.
            const code = this.stack.findLast((node) => node.type === "code");
            if (code !== undefined) {
              fenceLines.set(code, [...(fenceLines.get(code) ?? []), token.start.line]);
            }
          },
        },
      },
    ],
  });
  const lines = markdown.split(/\r\n|\r|\n/);
  const fences: CodeFence[] = [];
  visitParents(tree, "code", (node, ancestors) => {
    const [openLine, closeLine] = fenceLines.get(node) ?? [];
    if (openLine === undefined) {
      return;
    }
    fences.push({
      lang: node.lang ?? "",
      info: [node.lang, node.meta].filter((word) => word !== null && word !== undefined).join(" "),
      body: node.value,
      line: openLine,
      opener: lines[openLine - 1] ?? "",
      closer: closeLine === undefined ? null : (lines[closeLine - 1] ?? ""),
      endLine: closeLine ?? node.position?.end.line ?? openLine,
      nested: ancestors.length > 1,
    });
  });
  return fences;
}

/** The text of every fenced code block whose info string is exactly `info`. */
export function fencedBlocks(markdown: string, info: string): string[] {
  return codeFences(markdown)
    .filter((fence) => fence.info === info)
    .map((fence) => fence.body);
}

/** The lines of a markdown section between `## <heading>` and the next `## `. */
export function sectionLines(markdown: string, heading: string, source: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    throw new Error(`no "## ${heading}" section found in ${source}`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Every row of every GFM table in `markdown`, header rows included and delimiter rows left out, each cell as its
 * trimmed source (code spans and links kept) whatever padding the formatter gave it.
 */
export function tableRows(markdown: string): string[][] {
  const tree = markdownTree(markdown);
  const rows: string[][] = [];
  visitParents(tree, "tableRow", (row) => {
    rows.push(
      row.children.map((cell) => {
        const start = cell.position?.start.offset;
        const end = cell.position?.end.offset;
        if (start === undefined || end === undefined) {
          throw new Error("BUG: mdast-util-from-markdown left a tableCell node without a position");
        }
        // The closing pipe goes; a cell ending in an escaped pipe keeps it, since that one is content.
        return markdown
          .slice(start, end)
          .replace(/^\|/, "")
          .replace(/(?<!\\)\|$/, "")
          .trim();
      }),
    );
  });
  return rows;
}
