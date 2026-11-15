/**
 * The marker grammar every generator splices through: `BEGIN GENERATED: <name> (hint)` to
 * `END GENERATED: <name>`, each written in the comment syntax of the file's own language, and
 * the three checks each region passes before its splice: its markers pair up, they sit where the
 * region's declaration says, and no other region's marker sits between them. A region belongs to
 * its generator: whatever sits between its markers is overwritten on the next regeneration, unread,
 * so hand-written text belongs outside the markers. Committed text that lands inside shows in the
 * diff of the regenerated file and stays in git; uncommitted text is gone.
 */

import { extname } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { visitParents } from "unist-util-visit-parents";
import { Parser } from "yaml";
import { formatted } from "./biome-format.js";

/** Which comment syntax a file's markers use: a complete `<!-- -->` comment, or a whole-line YAML `#` comment. */
export type MarkerSyntax = "html" | "yaml";

/** Character offsets of one marker: `[start, end)`. */
export type MarkerSpan = readonly [start: number, end: number];

export const SYNTAX_BY_EXTENSION: Readonly<Record<string, MarkerSyntax>> = {
  ".md": "html",
  ".yml": "yaml",
  ".yaml": "yaml",
};

/** The marker syntax `path`'s language uses; a file type without one throws. */
export function markerSyntaxFor(path: string): MarkerSyntax {
  const syntax = SYNTAX_BY_EXTENSION[extname(path)];
  if (syntax === undefined) {
    throw new Error(`no generated-region marker syntax is defined for ${path}`);
  }
  return syntax;
}

// The name is spliced into a regex unescaped, so the grammar admits only regex-literal characters.
const REGION_NAME_CLASS = "[a-z0-9-]+";

// A whole name, as regionBounds() admits it.
const REGION_NAME = new RegExp(`^${REGION_NAME_CLASS}$`);

// The name inside a marker's own text.
const MARKED_NAME = new RegExp(` GENERATED: (${REGION_NAME_CLASS})`);

/** A docs path for biome's markdown formatter: it picks the language and the config's overrides from the path, which need not exist. */
const MARKDOWN_PATH = "docs/generated-region.md";

function markerText(kind: "BEGIN" | "END", name: string): string {
  const hint = kind === "BEGIN" ? String.raw`(?: \([^)\n]*\))?` : "";
  return `${kind} GENERATED: ${name}${hint}`;
}

// Every comment the YAML lexer sees, so a marker-shaped line inside a block or quoted scalar
// (content, not a comment) can never pass as a marker.
function yamlComments(text: string): Array<{ offset: number; source: string }> {
  const comments: Array<{ offset: number; source: string }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    const token = node as { type?: unknown; offset?: unknown; source?: unknown };
    if (
      token.type === "comment" &&
      typeof token.offset === "number" &&
      typeof token.source === "string"
    ) {
      comments.push({ offset: token.offset, source: token.source });
      return;
    }
    for (const value of Object.values(node)) {
      walk(value);
    }
  };
  for (const token of new Parser().parse(text)) {
    walk(token);
  }
  return comments;
}

function markerSpans(
  text: string,
  kind: "BEGIN" | "END",
  name: string,
  syntax: MarkerSyntax,
): MarkerSpan[] {
  if (syntax === "html") {
    const re = new RegExp(`<!-- ${markerText(kind, name)} -->`, "g");
    return [...text.matchAll(re)].map((match) => [match.index, match.index + match[0].length]);
  }
  const re = new RegExp(`^# ${markerText(kind, name)}$`);
  return yamlComments(text).flatMap(({ offset, source }): MarkerSpan[] => {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    // A marker is the whole line: only indentation may precede it; its trailing blanks stay in the span.
    if (!re.test(source.trimEnd()) || text.slice(lineStart, offset).trim() !== "") {
      return [];
    }
    return [[offset, offset + source.length]];
  });
}

/** The region name of every BEGIN marker `text` carries in `syntax`, in file order: the scan the generated-output table and the build:check runner read. */
export function regionNames(text: string, syntax: MarkerSyntax): string[] {
  return markerSpans(text, "BEGIN", REGION_NAME_CLASS, syntax).flatMap(
    ([start, end]) => MARKED_NAME.exec(text.slice(start, end))?.[1] ?? [],
  );
}

/** Region `name`'s marker spans, or why its markers do not pair up, ending with the fix. */
function markerPair(
  text: string,
  name: string,
  syntax: MarkerSyntax,
): { begin: MarkerSpan; end: MarkerSpan } | string {
  if (!REGION_NAME.test(name)) {
    return `a region name is lowercase letters, digits, and dashes; got "${name}"`;
  }
  const begins = markerSpans(text, "BEGIN", name, syntax);
  const ends = markerSpans(text, "END", name, syntax);
  const [begin] = begins;
  const [end] = ends;
  if (begin === undefined || end === undefined || begins.length !== 1 || ends.length !== 1) {
    return `region "${name}" needs exactly one BEGIN and one END marker, found ${begins.length} and ${ends.length}; restore the missing marker or delete the repeated one`;
  }
  if (end[0] < begin[1]) {
    return `region "${name}" has its END marker before its BEGIN marker; put the BEGIN marker first`;
  }
  return { begin, end };
}

/** Region `name`'s marker spans: exactly one BEGIN and one END, in that order, else a throw. */
export function regionBounds(
  text: string,
  name: string,
  syntax: MarkerSyntax,
): { begin: MarkerSpan; end: MarkerSpan } {
  const pair = markerPair(text, name, syntax);
  if (typeof pair === "string") {
    throw new Error(pair);
  }
  return pair;
}

/** `text` with the span strictly between region `name`'s markers replaced by `body`, markers kept. */
export function replaceRegion(
  text: string,
  name: string,
  body: string,
  syntax: MarkerSyntax,
): string {
  const { begin, end } = regionBounds(text, name, syntax);
  return `${text.slice(0, begin[1])}${body}${text.slice(end[0])}`;
}

/**
 * Where a region belongs in its file. Markdown regions sit under a heading (the nearest heading
 * above both markers, as its source reads, hashes included) or close the file; YAML regions sit
 * directly under a top-level mapping key and end its mapping.
 */
export type RegionPlacement =
  | { readonly kind: "under-heading"; readonly heading: string }
  | { readonly kind: "tail" }
  | { readonly kind: "under-key"; readonly key: string };

/**
 * One region a generator owns: its markers' name, where they belong, and the body it writes between them. The body
 * is every byte between the markers, so a region on its own lines wraps its text in block() or markdownBlock().
 */
export interface GeneratedRegion {
  /** The markers' name: lowercase letters, digits, and dashes. */
  readonly name: string;

  /** Where the markers must sit, checked before any splice. */
  readonly placement: RegionPlacement;

  /** The body, rendered when the file is regenerated. */
  readonly render: () => string;
}

/** `text` as the body of a block region: on the lines between the markers, each marker owning its line. */
export function block(text: string): string {
  return `\n${text}\n`;
}

/**
 * `text` as the body of a block region in a markdown page, formatted as biome formats the page (without the final
 * newline biome adds), since the lint judges a committed page like hand-written markdown. A region in a YAML file
 * stays with block(): its body is formatted in the file's context, never alone.
 */
export function markdownBlock(text: string): string {
  return block(formatted(MARKDOWN_PATH, text).replace(/\n$/, ""));
}

type MarkdownTree = ReturnType<typeof fromMarkdown>;
type MarkdownNode = MarkdownTree | MarkdownTree["children"][number];

interface MarkdownScan {
  /** Code blocks, fenced or indented, as CommonMark closes them: an unclosed fence runs to the end of its container. */
  readonly code: readonly MarkerSpan[];

  /** Inline code spans, backticks included. */
  readonly codeSpans: readonly MarkerSpan[];

  /** HTML nodes, block or inline; a block runs to the line its kind ends on, or the end of its container. */
  readonly html: readonly MarkerSpan[];

  /** Blockquotes, whole. */
  readonly quoted: readonly MarkerSpan[];

  /** Headings outside every blockquote, each as its trimmed source. */
  readonly headings: ReadonlyArray<{ readonly offset: number; readonly text: string }>;
}

function nodeSpan(node: MarkdownNode): MarkerSpan {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error(`BUG: mdast-util-from-markdown left a ${node.type} node without a position`);
  }
  return [start, end];
}

// The parser applies CommonMark's container rules, so a fence-, tag-, or heading-shaped line inside a
// code block, an HTML block, or a deeper blockquote is content, never a block of its own. Tables are
// parsed as GitHub does: a table ends at the next block, so an indented line after one is code.
function scanMarkdown(text: string): MarkdownScan {
  const code: MarkerSpan[] = [];
  const codeSpans: MarkerSpan[] = [];
  const html: MarkerSpan[] = [];
  const quoted: MarkerSpan[] = [];
  const headings: Array<{ offset: number; text: string }> = [];
  // The span list each node type feeds; a heading is read for its text instead.
  const spansByType: Readonly<Record<string, MarkerSpan[]>> = {
    code,
    inlineCode: codeSpans,
    html,
    blockquote: quoted,
  };
  const tree = fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  visitParents(tree, (node, ancestors) => {
    spansByType[node.type]?.push(nodeSpan(node));
    if (node.type === "heading" && !ancestors.some((ancestor) => ancestor.type === "blockquote")) {
      const [start, end] = nodeSpan(node);
      headings.push({ offset: start, text: text.slice(start, end).trim() });
    }
  });
  return { code, codeSpans, html, quoted, headings };
}

/** The span among `spans` holding offset `at`, if any. */
function enclosing(spans: readonly MarkerSpan[], at: number): MarkerSpan | undefined {
  return spans.find(([start, stop]) => start <= at && at < stop);
}

/** What the marker at `at` is content of, or undefined for one that is a block of its own. A marker is its own
 * HTML node (a comment block, or inline HTML); inside any other node it is that node's content. Two markers on one
 * line share the BEGIN marker's comment block, at `beginAt`. */
function markerInside(
  scan: MarkdownScan,
  text: string,
  at: number,
  beginAt: number,
): string | undefined {
  if (enclosing(scan.code, at) !== undefined) {
    return "a code block";
  }
  if (enclosing(scan.codeSpans, at) !== undefined) {
    return "a code span";
  }
  /** Whether the marker at `markerAt` opens `node`, nothing but indentation before it. */
  const opens = (node: MarkerSpan, markerAt: number): boolean =>
    node[0] <= markerAt && text.slice(node[0], markerAt).trim() === "";
  const html = enclosing(scan.html, at);
  if (html !== undefined && !opens(html, at) && !opens(html, beginAt)) {
    return "a raw HTML block";
  }
  if (enclosing(scan.quoted, at) !== undefined) {
    return "a blockquote";
  }
  return undefined;
}

function assertMarkdownPlacement(
  text: string,
  name: string,
  placement: Exclude<RegionPlacement, { kind: "under-key" }>,
  begin: MarkerSpan,
  end: MarkerSpan,
  path: string,
): void {
  const scan = scanMarkdown(text);
  for (const at of [begin[0], end[0]]) {
    const inside = markerInside(scan, text, at, begin[0]);
    if (inside !== undefined) {
      throw new Error(`the ${name} region sits inside ${inside} in ${path}`);
    }
  }
  if (placement.kind === "tail") {
    if (text.slice(end[1]).trim() !== "") {
      throw new Error(`the ${name} region must close ${path}`);
    }
    return;
  }
  const headingAbove = (at: number): string | undefined =>
    scan.headings.filter((heading) => heading.offset < at).at(-1)?.text;
  for (const [marker, at] of [
    ["BEGIN", begin[0]],
    ["END", end[0]],
  ] as const) {
    const actual = headingAbove(at);
    if (actual !== placement.heading) {
      const found =
        actual === undefined ? "no heading precedes" : `"${actual}" is the heading above`;
      throw new Error(
        `the ${name} region must sit under "${placement.heading}" in ${path}; ${found} its ${marker} marker`,
      );
    }
  }
}

function assertYamlPlacement(
  text: string,
  name: string,
  key: string,
  begin: MarkerSpan,
  end: MarkerSpan,
  path: string,
): void {
  const content = (line: string): boolean => line.trim() !== "" && !/^\s*#/.test(line);
  const beginLine = text.lastIndexOf("\n", begin[0] - 1) + 1;
  const above = text.slice(0, beginLine).split("\n").filter(content).at(-1);
  if (above === undefined || above.trimEnd() !== `${key}:`) {
    const found =
      above === undefined
        ? "nothing precedes its BEGIN marker"
        : `"${above.trim()}" precedes its BEGIN marker`;
    throw new Error(
      `the ${name} region must sit directly under the "${key}:" mapping in ${path}; ${found}`,
    );
  }
  // The END marker's own line holds only trailing blanks past the span, so the search skips it.
  const below = text.slice(end[1]).split("\n").slice(1).find(content);
  if (below !== undefined && /^\s/.test(below)) {
    throw new Error(
      `the ${name} region must end the "${key}:" mapping in ${path}; "${below.trim()}" follows its END marker`,
    );
  }
}

/**
 * Throw unless `region`'s markers pair up and sit where its placement says: a relocated marker would
 * otherwise regenerate cleanly while the page reads wrong. `path` picks the marker syntax and is
 * named in every refusal. The spans are returned for the enclosed-marker check.
 */
export function assertRegionPlacement(
  text: string,
  region: GeneratedRegion,
  path: string,
): { begin: MarkerSpan; end: MarkerSpan } {
  const syntax = markerSyntaxFor(path);
  const pair = markerPair(text, region.name, syntax);
  if (typeof pair === "string") {
    throw new Error(`${path}: ${pair}`);
  }
  const { begin, end } = pair;
  if (region.placement.kind === "under-key") {
    if (syntax !== "yaml") {
      throw new Error(
        `the ${region.name} region declares a YAML parent key, but ${path} uses ${syntax} markers`,
      );
    }
    assertYamlPlacement(text, region.name, region.placement.key, begin, end, path);
  } else {
    if (syntax !== "html") {
      throw new Error(
        `the ${region.name} region declares a markdown placement, but ${path} uses ${syntax} markers`,
      );
    }
    assertMarkdownPlacement(text, region.name, region.placement, begin, end, path);
  }
  return pair;
}

/**
 * `text` with every region in `regions` checked first (markers paired and placed, and no marker of any
 * region, this generator's or another's, between them), then its body overwritten with the rendered
 * one. `path` picks the marker syntax.
 */
export function regenerateRegions(
  text: string,
  regions: readonly GeneratedRegion[],
  path: string,
): string {
  const syntax = markerSyntaxFor(path);
  const names = new Set<string>();
  for (const region of regions) {
    if (names.has(region.name)) {
      throw new Error(`the ${region.name} region of ${path} is declared twice`);
    }
    names.add(region.name);
    const { begin, end } = assertRegionPlacement(text, region, path);
    const inner = [
      ...markerSpans(text, "BEGIN", REGION_NAME_CLASS, syntax),
      ...markerSpans(text, "END", REGION_NAME_CLASS, syntax),
    ].find(([start]) => begin[1] <= start && start < end[0]);
    if (inner !== undefined) {
      const other = MARKED_NAME.exec(text.slice(...inner))?.[1];
      throw new Error(
        `${path}: the ${region.name} region encloses a marker of the ${other} region, which regenerating would erase; move the markers apart, so each region encloses only its own body`,
      );
    }
  }
  return regions.reduce(
    (current, region) => replaceRegion(current, region.name, region.render(), syntax),
    text,
  );
}
