// The marker grammar every generator splices through: `BEGIN GENERATED: <name> (hint)` to
// `END GENERATED: <name>`, each written in the comment syntax of the file's own language.

import { extname } from "node:path";
import { Parser } from "yaml";

/** Which comment syntax a file's markers use: a complete `<!-- -->` comment, or a whole-line YAML `#` comment. */
export type MarkerSyntax = "html" | "yaml";

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
