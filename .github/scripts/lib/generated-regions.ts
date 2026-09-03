// The marker grammar every generator splices through: `BEGIN GENERATED: <name> (hint)` to
// `END GENERATED: <name>`, each written in the comment syntax of the file's own language, and
// the placement check each region passes before its splice (a RegionSpec says where it belongs).

import { extname } from "node:path";
import { Parser } from "yaml";

/** Which comment syntax a file's markers use: a complete `<!-- -->` comment, or a whole-line YAML `#` comment. */
export type MarkerSyntax = "html" | "yaml";

/** `text` as a regex source matching itself literally; body shapes splice renderer constants through it. */
export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Character offsets of one marker: `[start, end)`. */
export type MarkerSpan = readonly [start: number, end: number];

const SYNTAX_BY_EXTENSION: Readonly<Record<string, MarkerSyntax>> = {
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
const REGION_NAME = /^[a-z0-9-]+$/;

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
 * Where a region belongs in its file. Markdown regions sit under a heading (the nearest ATX
 * heading line above both markers, hashes included) or close the file; YAML regions sit directly
 * under a top-level mapping key and end its mapping.
 */
type RegionPlacement =
  | { readonly kind: "under-heading"; readonly heading: string }
  | { readonly kind: "tail" }
  | { readonly kind: "under-key"; readonly key: string };

/** A generated region as its generator declares it: its markers' name, its home, and the shape of its body. */
export interface RegionSpec {
  readonly name: string;
  readonly placement: RegionPlacement;
  /** Matches every body this generator could have written (stale or fresh), and nothing authored. */
  readonly body: RegExp;
}

interface MarkdownScan {
  /** Fenced code blocks, an unclosed one running to the end of the text. */
  readonly fenced: readonly MarkerSpan[];
  /** Raw HTML blocks, from the opening tag's line to the end of the line closing it (or of the text). */
  readonly raw: readonly MarkerSpan[];
  /** Blockquoted lines, whole. */
  readonly quoted: readonly MarkerSpan[];
  /** ATX headings outside all three, each as its trimmed line. */
  readonly headings: ReadonlyArray<{ readonly offset: number; readonly text: string }>;
}

/** The container a line sits in: up to `limit` blockquote markers stripped, and the content after them. */
function unquoted(line: string, limit: number): { depth: number; body: string } {
  let depth = 0;
  let body = line;
  for (
    let marker = body.match(/^ {0,3}> ?/);
    marker !== null && depth < limit;
    marker = body.match(/^ {0,3}> ?/)
  ) {
    depth += 1;
    body = body.slice(marker[0].length);
  }
  return { depth, body };
}

/** A fenced code block or raw HTML block still open, with the blockquote depth it opened at. */
type OpenBlock =
  | { kind: "fence"; start: number; depth: number; char: string; length: number }
  | { kind: "raw"; start: number; depth: number };

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
// A raw HTML block (CommonMark's first kind) opens only at block position, on one of four tags
// followed by a delimiter, and ends on a line holding any of their closing tags.
const RAW_OPEN = /^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)/i;
const RAW_CLOSE = /<\/(?:pre|script|style|textarea)>/i;

// One pass over CommonMark's fence, raw-block, and blockquote rules: a block opens and closes only
// by its own rule at its own blockquote depth, and everything inside it (fence-, tag-, and
// heading-shaped lines) is content. The test suite names each rule.
function scanMarkdown(text: string): MarkdownScan {
  const fenced: MarkerSpan[] = [];
  const raw: MarkerSpan[] = [];
  const quoted: MarkerSpan[] = [];
  const headings: Array<{ offset: number; text: string }> = [];
  let open: OpenBlock | undefined;
  let offset = 0;
  const close = (block: OpenBlock, stop: number): void => {
    (block.kind === "fence" ? fenced : raw).push([block.start, stop]);
    open = undefined;
  };
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    let { depth, body } = unquoted(line, open?.depth ?? Infinity);
    if (open !== undefined && depth < open.depth) {
      close(open, offset - 1);
      ({ depth, body } = unquoted(line, Infinity));
    }
    if (depth > 0) {
      quoted.push([offset, lineEnd]);
    }
    if (open?.kind === "raw") {
      if (RAW_CLOSE.test(body)) {
        close(open, lineEnd);
      }
    } else if (open?.kind === "fence") {
      const run = body.match(FENCE_LINE);
      const marks = run?.[1] ?? "";
      if (
        marks.charAt(0) === open.char &&
        marks.length >= open.length &&
        (run?.[2] ?? "").trim() === ""
      ) {
        close(open, lineEnd);
      }
    } else {
      const run = body.match(FENCE_LINE);
      const marks = run?.[1] ?? "";
      if (run !== null && !(marks.startsWith("`") && (run[2] ?? "").includes("`"))) {
        open = { kind: "fence", start: offset, depth, char: marks.charAt(0), length: marks.length };
      } else if (depth === 0 && HEADING_LINE.test(body)) {
        headings.push({ offset, text: body.trim() });
      } else if (RAW_OPEN.test(body)) {
        open = { kind: "raw", start: offset, depth };
        if (RAW_CLOSE.test(body)) {
          close(open, lineEnd);
        }
      }
    }
    offset = lineEnd + 1;
  }
  if (open !== undefined) {
    close(open, text.length);
  }
  return { fenced, raw, quoted, headings };
}

function assertMarkdownPlacement(
  text: string,
  spec: RegionSpec,
  placement: Exclude<RegionPlacement, { kind: "under-key" }>,
  begin: MarkerSpan,
  end: MarkerSpan,
  path: string,
): void {
  const scan = scanMarkdown(text);
  const inside = (spans: readonly MarkerSpan[], at: number): boolean =>
    spans.some(([start, stop]) => start <= at && at < stop);
  for (const [marker, at] of [
    ["BEGIN", begin[0]],
    ["END", end[0]],
  ] as const) {
    // Four columns of indentation (a tab counts as four) open an indented code block.
    const line = unquoted(text.slice(text.lastIndexOf("\n", at - 1) + 1, at), Infinity).body;
    const indent = line.match(/^[ \t]*/)?.[0] ?? "";
    if (indent.includes("\t") || indent.length >= 4) {
      throw new Error(
        `the ${spec.name} region's ${marker} marker sits on a line indented as code in ${path}`,
      );
    }
    if (inside(scan.fenced, at)) {
      throw new Error(`the ${spec.name} region sits inside a fenced code block in ${path}`);
    }
    if (inside(scan.raw, at)) {
      throw new Error(`the ${spec.name} region sits inside a raw HTML block in ${path}`);
    }
    if (inside(scan.quoted, at)) {
      throw new Error(`the ${spec.name} region sits inside a blockquote in ${path}`);
    }
  }
  if (placement.kind === "tail") {
    if (text.slice(end[1]).trim() !== "") {
      throw new Error(`the ${spec.name} region must close ${path}`);
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
        `the ${spec.name} region must sit under "${placement.heading}" in ${path}; ${found} its ${marker} marker`,
      );
    }
  }
}

function assertYamlPlacement(
  text: string,
  spec: RegionSpec,
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
      `the ${spec.name} region must sit directly under the "${key}:" mapping in ${path}; ${found}`,
    );
  }
  // The END marker's own line holds only trailing blanks past the span, so the search skips it.
  const below = text.slice(end[1]).split("\n").slice(1).find(content);
  if (below !== undefined && /^\s/.test(below)) {
    throw new Error(
      `the ${spec.name} region must end the "${key}:" mapping in ${path}; "${below.trim()}" follows its END marker`,
    );
  }
}

/**
 * Throw unless region `spec.name` sits where `spec.placement` says and encloses only a body
 * `spec.body` matches; a relocated marker would otherwise regenerate cleanly while the page
 * reads wrong, or erase the authored text it came to enclose. `path` picks the marker syntax.
 */
export function assertRegionPlacement(text: string, spec: RegionSpec, path: string): void {
  if (/[gy]/.test(spec.body.flags)) {
    throw new Error(
      `the ${spec.name} region's body shape carries the stateful "${spec.body.flags}" flags; test() would alternate between calls`,
    );
  }
  const syntax = markerSyntaxFor(path);
  const { begin, end } = regionBounds(text, spec.name, syntax);
  if (spec.placement.kind === "under-key") {
    if (syntax !== "yaml") {
      throw new Error(
        `the ${spec.name} region declares a YAML parent key, but ${path} uses ${syntax} markers`,
      );
    }
    assertYamlPlacement(text, spec, spec.placement.key, begin, end, path);
  } else {
    if (syntax !== "html") {
      throw new Error(
        `the ${spec.name} region declares a markdown placement, but ${path} uses ${syntax} markers`,
      );
    }
    assertMarkdownPlacement(text, spec, spec.placement, begin, end, path);
  }
  if (!spec.body.test(text.slice(begin[1], end[0]))) {
    throw new Error(
      `the ${spec.name} region in ${path} encloses content the generator would not write; move its marker back`,
    );
  }
}

/** A generated region with the renderer that writes its body: the exact text between the markers. */
export interface GeneratedRegion extends RegionSpec {
  readonly render: () => string;
}

/**
 * `text` with every region in `regions` checked for placement first, then its body re-rendered;
 * a rendering its own shape rejects fails here rather than on the next run. `path` picks the
 * marker syntax.
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
    if (!region.body.test(body)) {
      throw new Error(
        `the ${region.name} region's renderer wrote a body its own shape rejects: ${JSON.stringify(body)}`,
      );
    }
    return replaceRegion(current, region.name, body, syntax);
  }, text);
}
