// Small markdown helpers shared by the docs contract tests: the lines of a named "## heading"
// section, and the fenced code blocks carrying a given info string.

/** The contents of every fenced code block whose info string is exactly `info`. */
export function fencedBlocks(markdown: string, info: string): string[] {
  const blocks: string[] = [];
  const escaped = info.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Leading whitespace is tolerated and stripped (the README nests fences
  // inside list items, indenting fence and body alike), and longer fences
  // close per CommonMark (the closer carries at least the opener's length).
  // The guides additionally pin their fences to column zero, three backticks
  // exactly, so this extractor cannot miss a docs/ block.
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
