// The marker grammar every generator splices through: `BEGIN GENERATED: <name> (hint)` to
// `END GENERATED: <name>`, each written in the comment syntax of the file's own language, and
// the two checks each region passes before its splice: its placement, and the parse-render round
// trip over its body that GeneratedRegion.of() is the one way to declare.

import { extname } from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { err, ok, type Result } from "neverthrow";
import { Parser } from "yaml";

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
const REGION_NAME = new RegExp(`^${REGION_NAME_CLASS}$`);

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

/** True when `text` carries a BEGIN marker of any region in `syntax`: the scan the generated-output table is pinned against. */
export function hasGeneratedRegion(text: string, syntax: MarkerSyntax): boolean {
  return markerSpans(text, "BEGIN", REGION_NAME_CLASS, syntax).length > 0;
}

/** Region `name`'s marker spans: exactly one BEGIN and one END, in that order, else a throw. */
export function regionBounds(
  text: string,
  name: string,
  syntax: MarkerSyntax,
): { begin: MarkerSpan; end: MarkerSpan } {
  if (!REGION_NAME.test(name)) {
    throw new Error(`a region name is lowercase letters, digits, and dashes; got "${name}"`);
  }
  const begins = markerSpans(text, "BEGIN", name, syntax);
  const ends = markerSpans(text, "END", name, syntax);
  const [begin] = begins;
  const [end] = ends;
  if (begin === undefined || end === undefined || begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `region "${name}" needs exactly one BEGIN and one END marker, found ${begins.length} and ${ends.length}`,
    );
  }
  if (end[0] < begin[1]) {
    throw new Error(`region "${name}" has its END marker before its BEGIN marker`);
  }
  return { begin, end };
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
 * What a generator declares for one region: its markers' name, where it belongs, and its body as the
 * data it renders from. The body is every byte between the markers, so a block region's `render`
 * usually wraps in block().
 */
export interface RegionDeclaration<Data> {
  readonly name: string;
  readonly placement: RegionPlacement;
  /** The data the committed file is regenerated from. */
  readonly data: () => Data;
  /** The body for `data`. */
  readonly render: (data: Data) => string;
  /**
   * A body read back into the data it renders from, or why it is not one `render` wrote; a line it
   * names counts from the BEGIN marker's line as line 0.
   */
  readonly parse: (body: string) => Result<Data, string>;
}

/** The first line on which `body` differs from `rendered`, or undefined when they are the same bytes. */
function renderedMismatch(body: string, rendered: string): string | undefined {
  if (rendered === body) {
    return undefined;
  }
  const authored = body.split("\n");
  const expected = rendered.split("\n");
  const differing = authored.findIndex((line, i) => line !== expected[i]);
  const at = differing === -1 ? authored.length : differing;
  return `line ${at} reads ${JSON.stringify(authored[at] ?? "")} where the generator writes ${JSON.stringify(expected[at] ?? "")}`;
}

/**
 * The body check of a declaration: a body holding nothing (fresh markers, or an empty rendering) is
 * admitted and renders next; any other must parse, and re-rendering what it parsed to must
 * reproduce it byte for byte, so an authored spelling the renderer never writes is refused rather
 * than erased.
 */
function roundTrip<Data>(decl: RegionDeclaration<Data>): (body: string) => string | undefined {
  return (body) =>
    body.trim() === ""
      ? undefined
      : decl.parse(body).match(
          (data) => renderedMismatch(body, decl.render(data)),
          (refusal) => refusal,
        );
}

/**
 * A region as the generators hand it to regenerateRegions(). Only of() mints one: the constructor is
 * private and the class nominal, so a region's body check is always its own declaration's round trip
 * and no region can carry a grammar written beside its renderer.
 */
export class GeneratedRegion {
  private constructor(
    readonly name: string,
    readonly placement: RegionPlacement,
    private readonly check: (body: string) => string | undefined,
    private readonly body: () => string,
  ) {}

  static of<Data>(decl: RegionDeclaration<Data>): GeneratedRegion {
    return new GeneratedRegion(decl.name, decl.placement, roundTrip(decl), () =>
      decl.render(decl.data()),
    );
  }

  /** Why `body` is not one the renderer wrote, or undefined for a body it could have written. */
  bodyRefusal(body: string): string | undefined {
    return this.check(body);
  }

  /** The body rendered from the declaration's data. */
  render(): string {
    return this.body();
  }
}

/** The body of a block region: `render`'s text on the lines between the markers, each marker owning its line. */
export function block<Data>(render: (data: Data) => string): (data: Data) => string {
  return (data) => `\n${render(data)}\n`;
}

/** A block region's body as its lines, the first being line 1; or why the markers do not own their lines. */
export function blockLines(body: string): Result<string[], string> {
  if (!body.startsWith("\n")) {
    return err("line 0 runs on past the BEGIN marker");
  }
  if (!body.endsWith("\n")) {
    return err("the last line runs on into the END marker");
  }
  return ok(body.slice(1, -1).split("\n"));
}

/** The one line of a block region holding one line, or why the body is not that. */
export function blockLine(body: string): Result<string, string> {
  return blockLines(body).andThen((lines) =>
    lines.length === 1
      ? ok(lines[0] ?? "")
      : err(`line ${lines.length} is a line past the one the generator writes`),
  );
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
  const walk = (node: MarkdownNode, inQuote: boolean): void => {
    if (node.type === "code") {
      code.push(nodeSpan(node));
    } else if (node.type === "inlineCode") {
      codeSpans.push(nodeSpan(node));
    } else if (node.type === "html") {
      html.push(nodeSpan(node));
    } else if (node.type === "blockquote") {
      quoted.push(nodeSpan(node));
    } else if (node.type === "heading" && !inQuote) {
      const [start, end] = nodeSpan(node);
      headings.push({ offset: start, text: text.slice(start, end).trim() });
    }
    if ("children" in node) {
      for (const child of node.children) {
        walk(child, inQuote || node.type === "blockquote");
      }
    }
  };
  const tree = fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  walk(tree, false);
  return { code, codeSpans, html, quoted, headings };
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
  const enclosing = (spans: readonly MarkerSpan[], at: number): MarkerSpan | undefined =>
    spans.find(([start, stop]) => start <= at && at < stop);
  /** Whether the marker at `at` opens `node`, nothing but indentation before it. */
  const opens = (node: MarkerSpan, at: number): boolean =>
    node[0] <= at && text.slice(node[0], at).trim() === "";
  for (const at of [begin[0], end[0]]) {
    if (enclosing(scan.code, at) !== undefined) {
      throw new Error(`the ${name} region sits inside a code block in ${path}`);
    }
    if (enclosing(scan.codeSpans, at) !== undefined) {
      throw new Error(`the ${name} region sits inside a code span in ${path}`);
    }
    // A marker is its own HTML node (a comment block, or inline HTML); inside any other node it is
    // that node's content. Two markers on one line share the BEGIN marker's comment block.
    const html = enclosing(scan.html, at);
    if (html !== undefined && !opens(html, at) && !opens(html, begin[0])) {
      throw new Error(`the ${name} region sits inside a raw HTML block in ${path}`);
    }
    if (enclosing(scan.quoted, at) !== undefined) {
      throw new Error(`the ${name} region sits inside a blockquote in ${path}`);
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
 * Throw unless `region` sits where its placement says and encloses only a body its round trip
 * admits; a relocated marker would otherwise regenerate cleanly while the page reads wrong, or
 * erase the authored text it came to enclose. `path` picks the marker syntax.
 */
export function assertRegionPlacement(text: string, region: GeneratedRegion, path: string): void {
  const syntax = markerSyntaxFor(path);
  const { begin, end } = regionBounds(text, region.name, syntax);
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
  const refusal = region.bodyRefusal(text.slice(begin[1], end[0]));
  if (refusal !== undefined) {
    throw new Error(
      `the ${region.name} region in ${path} encloses content the generator would not write; move its marker back (${refusal}; line N is N lines below the BEGIN marker)`,
    );
  }
}

/**
 * `text` with every region in `regions` checked for placement first, then its body re-rendered;
 * a rendering its own parse does not read back fails here rather than on the next run. `path`
 * picks the marker syntax.
 */
export function regenerateRegions(
  text: string,
  regions: readonly GeneratedRegion[],
  path: string,
): string {
  const names = new Set<string>();
  for (const region of regions) {
    if (names.has(region.name)) {
      throw new Error(`the ${region.name} region of ${path} is declared twice`);
    }
    names.add(region.name);
    assertRegionPlacement(text, region, path);
  }
  const syntax = markerSyntaxFor(path);
  return regions.reduce((current, region) => {
    const body = region.render();
    const refusal = region.bodyRefusal(body);
    if (refusal !== undefined) {
      throw new Error(
        `the ${region.name} region's renderer wrote a body its own parse does not read back: ${JSON.stringify(body)} (${refusal})`,
      );
    }
    return replaceRegion(current, region.name, body, syntax);
  }, text);
}
