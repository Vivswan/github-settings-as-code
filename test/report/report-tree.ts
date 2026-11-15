/**
 * A reader for Markdown the report writer produced, the step summary and the report tables, shared by the tests.
 * It reads the GFM constructs the writer escapes for. The grammar is micromark's, and markdown.test.ts names the two
 * points where it differs from GitHub's.
 */

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";

/** The syntax tree of `markdown`, read with GFM tables, strikethrough, and bare-URL links. */
export function reportTree(markdown: string): ReturnType<typeof fromMarkdown> {
  return fromMarkdown(markdown, {
    extensions: [gfmTable(), gfmStrikethrough(), gfmAutolinkLiteral()],
    mdastExtensions: [
      gfmTableFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      gfmAutolinkLiteralFromMarkdown(),
    ],
  });
}
