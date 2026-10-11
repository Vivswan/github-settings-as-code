/**
 * The public entry's pin is docs/reference/library.md: the names in the API tables under "## The API by group" are
 * exactly what src/index.ts exports, in both directions, so a name is public only once the page says what it is.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { ROOT } from "../root.js";

const ENTRY = "src/index.ts";
const INTERNAL_ENTRY = "src/internal.ts";
const PAGE = "docs/reference/library.md";

/** Every name an entry exports, runtime and type-only alike, sorted; a star re-export has no names to pin and is refused. */
export function exportedNames(
  entry: string,
  text = readFileSync(join(ROOT, entry), "utf8"),
): string[] {
  const { module } = parseSync(entry, text);
  return module.staticExports
    .flatMap((statement) => statement.entries)
    .map((item) => {
      if (item.exportName.kind === "None") {
        throw new Error(
          `${entry} re-exports every name of ${item.moduleRequest?.value}; list the names`,
        );
      }
      return item.exportName.name ?? "";
    })
    .sort();
}

const API_HEADING = "## The API by group";

/** The header row of an API table, as GFM reads it (the leading pipe and the padding optional); the knob table's header is `| Knob |`. */
const NAME_TABLE_HEADER = /^\|?\s*Name\s*\|/;

/** A table row's first cell, when it is one code span: `| \`name\` | kind | says |`. */
const NAME_ROW = /^\|?\s*`([^`\s]+)`\s*\|/;

/** The header's delimiter row: dashes per column, the colons, the outer pipes, and the padding optional. */
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * The names the page documents: the first column of every `| Name |` table between "## The API by group" and the
 * next second-level heading, sorted. A table starts where a Name header is followed by a delimiter row and runs to
 * the next blank line, whatever its rows' leading whitespace or pipes, so every line in that span is a body row:
 * one whose first cell is not one code span is refused, so a misspelled row cannot read as absent, and a duplicate
 * row is kept, so the equality below reports it.
 */
export function documentedNames(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.indexOf(API_HEADING);
  if (start < 0) {
    throw new Error(`${PAGE} has no "${API_HEADING}" heading`);
  }
  // A line as GFM reads it: its blockquote depth (a marker is `>` plus any spaces, nested markers stack) and the text under the markers.
  const section = lines.slice(start + 1).map((raw) => {
    let text = raw.trim();
    let depth = 0;
    for (let marker = text.match(/^>\s*/); marker; marker = text.match(/^>\s*/)) {
      depth++;
      text = text.slice(marker[0].length);
    }
    return { depth, text: text.trim() };
  });
  const names: string[] = [];
  let inNameTable = false;
  // The open fence: its mark and the quote depth it opened at. A closer is the whole line at that depth; a `>` line
  // inside a fence at depth 0 is fence text, and so is a table. A line below the fence's depth ends the blockquote,
  // and the fence with it.
  let fence: { mark: string; depth: number } | null = null;
  for (const [offset, { depth, text: line }] of section.entries()) {
    // A backtick fence's info string carries no backtick, so a triple-backtick inline span is not an opener.
    const opener = line.match(/^(`{3,})(?![^`]*`)|^(~{3,})/)?.[0];
    if (fence !== null && depth < fence.depth) {
      fence = null;
    }
    if (fence !== null) {
      if (depth === fence.depth && line.startsWith(fence.mark) && /^(`+|~+)$/.test(line)) {
        fence = null;
      }
      continue;
    }
    if (opener !== undefined) {
      fence = { mark: opener, depth };
      inNameTable = false;
      continue;
    }
    if (line.startsWith("## ")) {
      break;
    }
    if (line === "") {
      inNameTable = false;
      continue;
    }
    if (!inNameTable) {
      if (NAME_TABLE_HEADER.test(line) && DELIMITER_ROW.test(section[offset + 1]?.text ?? "")) {
        inNameTable = true;
      }
      continue;
    }
    if (
      offset > 0 &&
      NAME_TABLE_HEADER.test(section[offset - 1]?.text ?? "") &&
      DELIMITER_ROW.test(line)
    ) {
      continue;
    }
    const match = line.match(NAME_ROW);
    if (match?.[1] === undefined) {
      throw new Error(
        `${PAGE}:${start + 2 + offset}: a Name table row must start with one code span, got: ${line}`,
      );
    }
    names.push(match[1]);
  }
  return names.sort();
}

describe("the public entry", () => {
  const page = readFileSync(join(ROOT, PAGE), "utf8");
  const entry = readFileSync(join(ROOT, ENTRY), "utf8");

  test("exports exactly the names the library page's API tables document", () => {
    const exported = exportedNames(ENTRY, entry);
    // The knob table under the heading has no `| Name |` header, so an extractor reading nothing would compare two empty lists.
    expect(exported).not.toEqual([]);
    expect(exported).toEqual(documentedNames(page));
  });

  test.each([
    ["| notExported | function | Extra |", /got: \| notExported \|/],
    ["| Name | function | Extra |", /got: \| Name \|/],
  ])(
    "a Name table body row whose first cell is not one code span (%s) is refused, not skipped (negative control)",
    (row, message) => {
      const bareRow = page.replace("| `Io` | type |", `${row}\n| \`Io\` | type |`);
      expect(bareRow).not.toBe(page);
      expect(() => documentedNames(bareRow)).toThrow(message);
    },
  );

  test("a Name table after the API section is not read (negative control)", () => {
    const afterSection = `${page}\n| Name | Kind | Says |\n|---|---|---|\n| \`notExported\` | function | A table after the API section |\n`;
    expect(documentedNames(afterSection)).toEqual(documentedNames(page));
  });

  // A fence shows its text; a table inside one renders as code, so it is not a documented name.
  const FENCED_TABLE =
    "| Name | Kind | Says |\n|---|---|---|\n| `notExported` | function | Fenced |";
  test.each([
    ["a backtick fence", `\`\`\`md\n${FENCED_TABLE}\n\`\`\``],
    ["a tilde fence", `~~~\n${FENCED_TABLE}\n~~~`],
    ["a fence whose body opens another fence", `\`\`\`md\n\`\`\`ts\n${FENCED_TABLE}\n\n\`\`\``],
    [
      "a fence inside a blockquote",
      `>   \`\`\`md\n> ${FENCED_TABLE.replaceAll("\n", "\n> ")}\n>\n>   \`\`\``,
    ],
    [
      "a fence whose body quotes a closed fence",
      `\`\`\`md\n> \`\`\`ts\n> const example = 1;\n> \`\`\`\n\n${FENCED_TABLE}\n\n\`\`\``,
    ],
  ])("%s holds shown text, not a documented name (negative control)", (_form, block) => {
    const fenced = page.replace("### Io\n", `### Io\n\n${block}\n\n`);
    expect(fenced).not.toBe(page);
    expect(documentedNames(fenced)).toEqual(documentedNames(page));
  });

  // Every table form GFM renders is read, so a row cannot escape the pin by its spelling.
  test.each([
    [
      "a row with leading whitespace",
      "| `Io` | type |",
      "  | `notExported` | function | Extra |\n| `Io` | type |",
    ],
    [
      "a row without a leading pipe",
      "| `Io` | type |",
      "`notExported` | function | Extra |\n| `Io` | type |",
    ],
    [
      "a table with a compact header",
      "### Io\n",
      "### Io\n\n|Name|Kind|Says|\n|---|---|---|\n|`notExported`|function|Extra|\n\n",
    ],
    [
      "a table whose delimiter row has no outer pipes",
      "### Io\n",
      "### Io\n\nName | Kind | Says\n--- | --- | ---\n`notExported` | function | Extra\n\n",
    ],
    [
      "a table inside a blockquote",
      "### Io\n",
      "### Io\n\n> | Name | Kind | Says |\n> |---|---|---|\n> | `notExported` | function | Quoted |\n\n",
    ],
    [
      "a table inside a nested blockquote whose markers are spaced apart",
      "### Io\n",
      "### Io\n\n>  > | Name | Kind | Says |\n>  > |---|---|---|\n>  > | `notExported` | function | Quoted |\n\n",
    ],
    [
      "a table after a quoted fence its blockquote ended without a closer",
      "### Io\n",
      "### Io\n\n> ```md\n> example\n\n| Name | Kind | Says |\n|---|---|---|\n| `notExported` | function | Extra |\n\n",
    ],
    [
      "a table after a triple-backtick inline span, which opens no fence",
      "### Io\n",
      "### Io\n\n```an inline `code` span```\n\n| Name | Kind | Says |\n|---|---|---|\n| `notExported` | function | Extra |\n\n",
    ],
  ])("%s is read as a documented name (negative control)", (_form, anchor, replacement) => {
    const variant = page.replace(anchor, replacement);
    expect(variant).not.toBe(page);
    expect(documentedNames(variant)).toEqual([...documentedNames(page), "notExported"].sort());
    expect(documentedNames(variant)).not.toEqual(exportedNames(ENTRY, entry));
  });

  test("a star re-export is refused, since it pins no names (negative control)", () => {
    expect(() => exportedNames(ENTRY, `${entry}export * from "./engine/outcome.js";\n`)).toThrow(
      `${ENTRY} re-exports every name of ./engine/outcome.js; list the names`,
    );
  });

  test("the two entries share no name", () => {
    const shared = exportedNames(INTERNAL_ENTRY).filter((name) =>
      exportedNames(ENTRY, entry).includes(name),
    );
    expect(shared).toEqual([]);
  });
});
