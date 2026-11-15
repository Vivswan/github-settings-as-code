import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { headingRange } from "mdast-util-heading-range";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfmTable } from "micromark-extension-gfm-table";
import { source as sourceText } from "unist-util-source";
import { visitParents } from "unist-util-visit-parents";

/** The syntax tree of a CommonMark document with GFM tables and YAML front matter, every node carrying its source position. */
export function markdownTree(markdown: string): ReturnType<typeof fromMarkdown> {
  return fromMarkdown(markdown, {
    extensions: [gfmTable(), frontmatter()],
    mdastExtensions: [gfmTableFromMarkdown(), frontmatterFromMarkdown()],
  });
}

type Code = Extract<ReturnType<typeof fromMarkdown>["children"][number], { type: "code" }>;

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

/** Every code block of `markdown` in order, with its ancestors and the lines of its fences: two for a closed fence, one for an unclosed one, none for an indented block. */
function codeBlocks(
  markdown: string,
): Array<{ node: Code; ancestors: unknown[]; fenceLines: number[] }> {
  // The parser's own fence tokens say where a block opens and whether it closes; the finished tree keeps neither.
  const fenceLines = new Map<object, number[]>();
  const tree = fromMarkdown(markdown, {
    extensions: [frontmatter()],
    mdastExtensions: [
      frontmatterFromMarkdown(),
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
  const blocks: ReturnType<typeof codeBlocks> = [];
  visitParents(tree, "code", (node, ancestors) => {
    blocks.push({ node, ancestors, fenceLines: fenceLines.get(node) ?? [] });
  });
  return blocks;
}

/** Every fenced code block of `markdown`, in order; an indented code block has no fence and is left out. */
export function codeFences(markdown: string): CodeFence[] {
  const lines = markdown.split(/\r\n|\r|\n/);
  const fences: CodeFence[] = [];
  for (const { node, ancestors, fenceLines } of codeBlocks(markdown)) {
    const [openLine, closeLine] = fenceLines;
    if (openLine === undefined) {
      continue;
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
  }
  return fences;
}

/** The indented code blocks that open on a fence line, each by its line and that line's source: a fence indented out of being one, so nothing reads its example. */
export function indentedFences(markdown: string): Array<{ line: number; opener: string }> {
  const lines = markdown.split(/\r\n|\r|\n/);
  return codeBlocks(markdown)
    .filter(
      ({ node, fenceLines }) => fenceLines.length === 0 && /^[ \t]*(`{3,}|~{3,})/.test(node.value),
    )
    .map(({ node }) => {
      const line = node.position?.start.line ?? 0;
      return { line, opener: lines[line - 1] ?? "" };
    });
}

/** The text of every fenced code block whose info string is exactly `info`. */
export function fencedBlocks(markdown: string, info: string): string[] {
  return codeFences(markdown)
    .filter((fence) => fence.info === info)
    .map((fence) => fence.body);
}

/**
 * The source of the section under the second-level heading whose text is `heading`: from the heading to the next heading
 * of the page's own outline at that level or above, or to the document's end. A heading inside a code block, a
 * blockquote, or a list item is content.
 */
export function sectionText(markdown: string, heading: string, source: string): string {
  let bounds: { from: number; to: number } | undefined;
  headingRange(
    markdownTree(markdown),
    (text, node) => node.depth === 2 && text === heading,
    (opener, _between, next) => {
      bounds = {
        from: opener.position?.end.offset ?? 0,
        to: next?.position?.start.offset ?? markdown.length,
      };
    },
  );
  if (bounds === undefined) {
    throw new Error(`no "## ${heading}" section found in ${source}`);
  }
  // Only the blank lines around the section go: an indent on its first line is content (an indented code block).
  return markdown
    .slice(bounds.from, bounds.to)
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .trimEnd();
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
        // The closing pipe goes; a cell ending in an escaped pipe keeps it, since that one is content.
        const text = sourceText(markdown, cell);
        if (text === undefined) {
          throw new Error("BUG: mdast-util-from-markdown left a tableCell node without a position");
        }
        return text
          .replace(/^\|/, "")
          .replace(/(?<!\\)\|$/, "")
          .trim();
      }),
    );
  });
  return rows;
}
