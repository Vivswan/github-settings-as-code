/**
 * The public entry's pin is docs/reference/library.md: the names in the API tables under "## The API by group" are
 * exactly what src/index.ts exports, in both directions, so a name is public only once the page says what it is.
 * The action reaches the rest of src/ only through the two entries; the architecture lint's controls are here too.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { ARCHITECTURE_PATH, lintArchitecture } from "../../.github/scripts/arch-lint.js";
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
  const section = lines.slice(start + 1).map((raw) => raw.trim());
  const names: string[] = [];
  let inNameTable = false;
  for (const [offset, line] of section.entries()) {
    if (line.startsWith("## ")) {
      break;
    }
    if (line === "") {
      inNameTable = false;
      continue;
    }
    if (!inNameTable) {
      if (NAME_TABLE_HEADER.test(line) && DELIMITER_ROW.test(section[offset + 1] ?? "")) {
        inNameTable = true;
      }
      continue;
    }
    if (
      offset > 0 &&
      NAME_TABLE_HEADER.test(section[offset - 1] ?? "") &&
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
    expect(exportedNames(ENTRY, entry)).toEqual(documentedNames(page));
  });

  test("the page documents more than one name per group (the extractor reads the tables)", () => {
    // The knob table under the heading has no `| Name |` header, so the count is the API tables alone.
    expect(documentedNames(page).length).toBeGreaterThan(50);
  });

  test("an export the page does not document fails the pin (negative control)", () => {
    const withoutRow = page.replace(/^\| `validateSettings` \|.*\n/m, "");
    expect(withoutRow).not.toBe(page);
    const documented = documentedNames(withoutRow);
    expect(documented).not.toEqual(exportedNames(ENTRY, entry));
    expect(exportedNames(ENTRY, entry).filter((name) => !documented.includes(name))).toEqual([
      "validateSettings",
    ]);
  });

  test("a documented name the entry does not export fails the pin (negative control)", () => {
    const withRow = page.replace(
      "| `Io` | type |",
      "| `notExported` | function | A row with no export behind it |\n| `Io` | type |",
    );
    expect(withRow).not.toBe(page);
    const documented = documentedNames(withRow);
    expect(documented).not.toEqual(exportedNames(ENTRY, entry));
    expect(documented.filter((name) => !exportedNames(ENTRY, entry).includes(name))).toEqual([
      "notExported",
    ]);
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
  ])("%s is read as a documented name (negative control)", (_form, anchor, replacement) => {
    const variant = page.replace(anchor, replacement);
    expect(variant).not.toBe(page);
    expect(documentedNames(variant)).toEqual([...documentedNames(page), "notExported"].sort());
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

  // A copy of src/ plus the offending file: the real tree draws every declared edge, so the forbidden import is the whole verdict.
  test.each([
    ["src/engine directly", "../engine/orchestrate.js", "engine", "src/engine/orchestrate.ts"],
    ["the internal entry", "../internal.js", "internal", "src/internal.ts"],
  ])(
    "a src/action file importing %s fails the architecture lint (negative control)",
    (_target, specifier, layer, resolved) => {
      const root = mkdtempSync(join(tmpdir(), "public-surface-"));
      try {
        cpSync(join(ROOT, "src"), join(root, "src"), { recursive: true });
        cpSync(join(ROOT, ARCHITECTURE_PATH), join(root, ARCHITECTURE_PATH));
        writeFileSync(
          join(root, "src/action/direct.ts"),
          `import { runForRepo } from "${specifier}";\nexport const direct = runForRepo;\n`,
        );
        expect(lintArchitecture(root)).toEqual([
          `forbidden import action -> ${layer}: src/action/direct.ts -> ${resolved}; move it or declare the edge`,
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
