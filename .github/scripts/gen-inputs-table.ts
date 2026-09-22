/** Renders the inputs table on docs/reference/inputs.md with action-docs, after refusing a marker region holding anything
 * but the lines of a rendering in the renderer's order: action-docs rewrites the region blind, and auto-fix.yml pushes
 * regenerations unreviewed, so an authored line that merely looks like a table row would be erased and committed. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateActionMarkdownDocs } from "action-docs";

const ROOT = join(import.meta.dir, "..", "..");

/** The page action-docs renders the inputs table into, from the action.yml build:action-docs writes just before. */
export const INPUTS_PAGE_PATH = "docs/reference/inputs.md";

export const MARKER = '<!-- action-docs-inputs source="action.yml" -->';

/** The header row action-docs emits; test/docs/inputs.test.ts pins the same cells on the committed page. */
const HEADER_CELLS = ["name", "description", "required", "default"];

/** The trimmed cells of a table line `| a | b |`, or null for any other line. One split per line and no regex: the
 * earlier four-cell regex backtracked exponentially on a long row of repeated cells. */
const cells = (line: string): string[] | null =>
  line.startsWith("| ") && line.endsWith(" |")
    ? line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
    : null;

type CellCheck = (cell: string) => boolean;

const lineOf =
  (checks: CellCheck[]) =>
  (line: string): boolean => {
    const found = cells(line);
    return (
      found !== null &&
      found.length === checks.length &&
      checks.every((ok, i) => ok(found[i] ?? ""))
    );
  };

const backticked: CellCheck = (cell) =>
  cell.length > 2 && cell.startsWith("`") && cell.endsWith("`");

/** A row action-docs renders: | `name` | <p>description</p> | `false` | `default` |. An authored four-cell row
 * with bare cells is refused on these, since a cell count alone let one through. */
const row = lineOf([
  backticked,
  (cell) => cell.startsWith("<p>") && cell.endsWith("</p>"),
  (cell) => cell === "`true`" || cell === "`false`",
  backticked,
]);

/** What action-docs writes between its markers, by position after the opening marker's own line ends:
 *
 * ""                                          the rest of the marker line
 * "## Inputs"
 * ""
 * "| name | description | required | default |"
 * "| --- | --- | --- | --- |"
 * one row per input                           a description never holds a "|" (test/docs/inputs.test.ts)
 * ""                                          before the closing marker
 *
 * A region of blank lines alone (a fresh marker pair) is also a rendering's shape. */
const LEADING: ((line: string) => boolean)[] = [
  (line) => line === "",
  (line) => line === "## Inputs",
  (line) => line === "",
  lineOf(HEADER_CELLS.map((name) => (cell: string) => cell === name)),
  lineOf(HEADER_CELLS.map(() => (cell: string) => cell === "---")),
];

/** Why `page` cannot be handed to action-docs, or null when its region holds only a rendering's lines in order. */
export function regionProblem(page: string): string | null {
  const parts = page.split(MARKER);
  if (parts.length !== 3) {
    return `${INPUTS_PAGE_PATH} must carry exactly two "${MARKER}" markers, found ${parts.length - 1}`;
  }
  const [intro, region] = parts as [string, string, string];
  const openingLine = intro.split("\n").length;
  const lines = region.split("\n");
  const last = lines.length - 1;
  if (last === 0) {
    // action-docs then replaces the opening marker alone and leaves three on the page.
    return `the closing "${MARKER}" marker on line ${openingLine} of ${INPUTS_PAGE_PATH} must start its own line`;
  }
  if (lines.every((line) => line === "")) {
    return null;
  }
  const authored = lines.findIndex((line, index) => {
    const leading = LEADING[index];
    if (leading !== undefined) {
      return !leading(line);
    }
    return index === last ? line !== "" : !row(line);
  });
  if (authored !== -1) {
    return (
      `line ${openingLine + authored} of ${INPUTS_PAGE_PATH} sits between the two "${MARKER}" markers ` +
      "but is not a line of a rendered inputs table; move the markers back around the table before " +
      "regenerating, or action-docs erases what sits between them"
    );
  }
  return null;
}

if (import.meta.main) {
  // action-docs resolves both files from the working directory and matches the marker on the literal source name.
  process.chdir(ROOT);
  const problem = regionProblem(readFileSync(INPUTS_PAGE_PATH, "utf8"));
  if (problem !== null) {
    console.error(`gen-inputs-table: ${problem}`);
    process.exit(1);
  }
  await generateActionMarkdownDocs({
    sourceFile: "action.yml",
    updateReadme: true,
    readmeFile: INPUTS_PAGE_PATH,
  });
  console.log(`gen-inputs-table: rendered ${INPUTS_PAGE_PATH} from action.yml`);
}
