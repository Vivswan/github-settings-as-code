/** Markdown building blocks shared by the private-report composer and the step summary; action-layer-free so the composer's independence holds. */

/** Backslashes FIRST: a bare backslash before an escaped pipe would read as an escaped backslash plus a live pipe and split the row. */
export function markdownCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n?|\n/g, " ");
}
