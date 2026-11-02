import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { visitParents } from "unist-util-visit-parents";

/** The contents of every fenced code block whose info string is exactly `info`. */
export function fencedBlocks(markdown: string, info: string): string[] {
  const blocks: string[] = [];
  const escaped = RegExp.escape(info);
  // Leading whitespace is stripped (the README nests fences inside list items) and longer fences close per CommonMark; the guides additionally pin
  // column-zero triple backticks, so this extractor cannot miss a docs/ block.
  const re = new RegExp(
    `^([ \\t]*)(\`{3,})${escaped}[ \\t]*\\n([\\s\\S]*?)^[ \\t]*\\2\`*[ \\t]*$`,
    "gm",
  );
  for (const m of markdown.matchAll(re)) {
    const indent = m[1] ?? "";
    const body = m[3] ?? "";
    blocks.push(
      indent === ""
        ? body
        : body
            .split("\n")
            .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
            .join("\n"),
    );
  }
  return blocks;
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
  const tree = fromMarkdown(markdown, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
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
