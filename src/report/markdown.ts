/**
 * Markdown building blocks shared by every surface that renders one: the
 * private-report composer (this directory) and the action layer's step
 * summary. Deliberately action-layer-free so the composer's independence
 * holds.
 */

/**
 * Escape a markdown table cell: backslashes FIRST (a bare backslash before an
 * escaped pipe would read as an escaped backslash plus a live pipe and split
 * the row), then pipes, then newlines flattened to spaces.
 */
export function markdownCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n?|\n/g, " ");
}
