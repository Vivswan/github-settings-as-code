// A generated region moved elsewhere in its file, the mutation every placement suite applies to a
// committed page or a fixture: the negative control a placement assertion exists to catch.

import { expect } from "bun:test";
import {
  type MarkerSpan,
  type MarkerSyntax,
  regionBounds,
} from "../../.github/scripts/lib/generated-regions.js";

/** Whether nothing but whitespace shares the marker's line. */
function ownsLine(text: string, [start, end]: MarkerSpan): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", end);
  return (
    text.slice(lineStart, start).trim() === "" &&
    text.slice(end, lineEnd === -1 ? text.length : lineEnd).trim() === ""
  );
}

/**
 * `text` with region `name` cut out and pasted right after `anchor`: a block region (each marker
 * owning its line) moves with its whole marker lines, an inline one moves as its marker span alone.
 */
export function relocatedRegion(
  text: string,
  name: string,
  syntax: MarkerSyntax,
  anchor: string,
): string {
  const { begin, end } = regionBounds(text, name, syntax);
  const block = ownsLine(text, begin) && ownsLine(text, end);
  const start = block ? text.lastIndexOf("\n", begin[0] - 1) + 1 : begin[0];
  const endLine = text.indexOf("\n", end[1]);
  const stop = block ? (endLine === -1 ? text.length : endLine + 1) : end[1];
  const region = text.slice(start, stop);
  const rest = text.slice(0, start) + text.slice(stop);
  expect(rest).toContain(anchor);
  return rest.replace(anchor, `${anchor}${region}`);
}
