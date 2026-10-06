/**
 * Markdown building blocks shared by the private-report composer, the step summary, and the docs generators;
 * action-layer-free so the composer's independence holds.
 *
 * One renderer, two kinds of cell:
 *   step summary    -> free text the caller escapes with markdownCell(); never refused
 *   generated page  -> authored prose refused rather than escaped, since an escape would change the author's text:
 *                      tableFault() before rendering, tableBody() when the committed page is read back
 */

import { err, ok, type Result } from "neverthrow";

/** Backslashes FIRST: a bare backslash before an escaped pipe would read as an escaped backslash plus a live pipe and split the row. */
export function markdownCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r\n?|\n/g, " ");
}

export function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

export function renderTable(header: string, rows: ReadonlyArray<readonly string[]>): string {
  return [header, ...rows.map(tableRow)].join("\n");
}

/** Why `text` cannot be a cell of authored prose: a pipe or a line break would split its row, a blank would leave its column empty. */
export function cellFault(text: string): string | undefined {
  return text.trim() === "" || /[|\r\n]/.test(text)
    ? 'is blank or contains "|" or a line break'
    : undefined;
}

/** The cells of one tableRow() line; a line of another shape yields the wrong count or fails the byte compare. */
function rowCells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.slice(1, -1));
}

function columnsOf(header: string): number {
  return rowCells(header.split("\n")[0] ?? "").length;
}

/** A settings key in a code span: the cell every registry table opens its rows with. */
const KEY_SPAN = /^`([a-z_]+)`$/;

/**
 * Which rule a table's rows pass. `cells`: every row has the header's cell count and no cell cellFault() refuses.
 * `keyed`: that, and each row opens with a key span no earlier row used, since the table walks a registry.
 */
export type TableRule = "cells" | "keyed";

/** The first row a TableRule refuses: its index among the rows, and why. */
export interface RowFault {
  readonly row: number;
  readonly fault: string;
}

function rowFault(
  columns: number,
  rows: ReadonlyArray<readonly string[]>,
  rule: TableRule,
): RowFault | undefined {
  const keys = new Set<string>();
  for (const [row, cells] of rows.entries()) {
    if (cells.length !== columns) {
      return { row, fault: `has ${cells.length} cells where the table has ${columns}` };
    }
    const faulty = cells.findIndex((cell) => cellFault(cell) !== undefined);
    if (faulty !== -1) {
      return { row, fault: `cell ${faulty + 1} ${cellFault(cells[faulty] ?? "")}` };
    }
    if (rule === "keyed") {
      const key = KEY_SPAN.exec(cells[0] ?? "")?.[1];
      if (key === undefined) {
        return { row, fault: "does not open with a section key in a code span" };
      }
      if (keys.has(key)) {
        return { row, fault: `repeats the \`${key}\` row` };
      }
      keys.add(key);
    }
  }
  return undefined;
}

/**
 * The one statement of what a table under `header` may hold, naming the first faulty row: a generator throws it
 * before rendering and tableBody() refuses by the same rule, so a test can hold both sides to it.
 */
export function tableFault(
  header: string,
  rows: ReadonlyArray<readonly string[]>,
  rule: TableRule,
): string | undefined {
  const faulty = rowFault(columnsOf(header), rows, rule);
  if (faulty === undefined) {
    return undefined;
  }
  return `row ${faulty.row + 1} of the table ${faulty.fault}: ${tableRow(rows[faulty.row] ?? [])}`;
}

/** `lines` read back as the rows of a table under `header`, split the way tableRow() joined them, or the first row `rule` refuses. */
export function tableRows(
  header: string,
  lines: readonly string[],
  rule: TableRule,
): Result<ReadonlyArray<readonly string[]>, RowFault> {
  const cells = lines.map(rowCells);
  const faulty = rowFault(columnsOf(header), cells, rule);
  return faulty === undefined ? ok(cells) : err(faulty);
}

/** The key of a row under `rule`: the span the keyed rule found, or the first cell itself. */
function rowKey(cells: readonly string[], rule: TableRule): string {
  const first = cells[0] ?? "";
  return rule === "keyed" ? (KEY_SPAN.exec(first)?.[1] ?? "") : first;
}

/**
 * The parse of a block region that is one table: the body splits into rows and cells, the rows pass `rule`,
 * and `parseRow` turns each row's cells into the record it renders from (`key` as rowKey() reads it), each
 * refusal naming the row's line below the BEGIN marker. A body not opening with `header` parses to no rows,
 * so the region's byte compare names its first line.
 */
export function tableBody<Row>(
  header: string,
  rule: TableRule,
  parseRow: (cells: readonly string[], key: string) => Result<Row, string>,
): (body: string) => Result<Row[], string> {
  const headerLines = header.split("\n").length;
  const line = (row: number): number => row + headerLines + 1;
  return (body) => {
    if (!(body.startsWith(`\n${header}\n`) && body.endsWith("\n"))) {
      return ok([]);
    }
    return tableRows(header, body.split("\n").slice(headerLines + 1, -1), rule)
      .mapErr((faulty) => `line ${line(faulty.row)} ${faulty.fault}`)
      .andThen((rows) => {
        const parsed: Row[] = [];
        for (const [index, cells] of rows.entries()) {
          const row = parseRow(cells, rowKey(cells, rule));
          if (row.isErr()) {
            return err(`line ${line(index)} ${row.error}`);
          }
          parsed.push(row.value);
        }
        return ok(parsed);
      });
  };
}
