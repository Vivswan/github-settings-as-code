// The markdown tables the generators write: a header constant over one `| a | b |` row per record. The cell rule,
// the row joiner, and the table rule are the whole grammar on both sides: renderTable() throws exactly what
// tableRoundTrip() refuses, so a renderer cannot write a body its own guard would not read back.

import { renderedMismatch } from "./generated-regions.js";

/** Why `text` cannot be a cell: a pipe or a line break would split its row, a blank would leave its column empty. */
function cellFault(text: string): string | undefined {
  return text.trim() === "" || /[|\r\n]/.test(text)
    ? 'is blank or contains "|" or a line break'
    : undefined;
}

/**
 * `text` as a cell of authored prose, refused rather than escaped: an escape would silently change the rendered text.
 * `where` names the cell as its author knows it.
 */
export function tableCell(text: string, where: string): string {
  const fault = cellFault(text);
  if (fault !== undefined) {
    throw new Error(`${where} ${fault}, which would break its table row: "${text}"`);
  }
  return text;
}

/** A settings key in a code span: the cell every generated table opens its rows with, written without tableCell(). */
const KEY_SPAN = /^`([a-z_]+)`$/;

export function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
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

/**
 * Why `rows` cannot sit under a header of `columns` cells, as the first faulty row and its fault: a wrong cell
 * count, a cell tableCell() refuses, a first cell that is no key span, or a key an earlier row already used (the
 * renderers walk a registry).
 */
function rowFault(
  columns: number,
  rows: ReadonlyArray<readonly string[]>,
): { readonly row: number; readonly fault: string } | undefined {
  const keys = new Set<string>();
  for (const [row, cells] of rows.entries()) {
    if (cells.length !== columns) {
      return { row, fault: `has ${cells.length} cells where the table has ${columns}` };
    }
    const faulty = cells.findIndex((cell) => cellFault(cell) !== undefined);
    if (faulty !== -1) {
      return { row, fault: `cell ${faulty + 1} ${cellFault(cells[faulty] ?? "")}` };
    }
    const key = KEY_SPAN.exec(cells[0] ?? "")?.[1];
    if (key === undefined) {
      return { row, fault: "does not open with a section key in a code span" };
    }
    if (keys.has(key)) {
      return { row, fault: `repeats the \`${key}\` row` };
    }
    keys.add(key);
  }
  return undefined;
}

/**
 * The one statement of what a table under `header` may hold, naming the first faulty row: renderTable() throws it
 * and tableRoundTrip() refuses by the same rule, so a test can hold both sides to it.
 */
export function tableFault(
  header: string,
  rows: ReadonlyArray<readonly string[]>,
): string | undefined {
  const faulty = rowFault(columnsOf(header), rows);
  if (faulty === undefined) {
    return undefined;
  }
  return `row ${faulty.row + 1} of the table ${faulty.fault}: ${tableRow(rows[faulty.row] ?? [])}`;
}

export function renderTable(header: string, rows: ReadonlyArray<readonly string[]>): string {
  const fault = tableFault(header, rows);
  if (fault !== undefined) {
    throw new Error(fault);
  }
  return [header, ...rows.map(tableRow)].join("\n");
}

/**
 * The body guard of a generated table region. The body splits into rows and cells the way renderTable() joined
 * them and passes the same row rule, `parseRow` turns a row's cells into the record it renders from (a string
 * is the refusal), and `renderRows` must reproduce the body byte for byte, so an authored spelling the renderer
 * never writes is refused rather than erased. A freshly placed region holds "\n" and renders next.
 */
export function tableRoundTrip<Row>(
  header: string,
  parseRow: (cells: readonly string[], key: string) => Row | string,
  renderRows: (rows: readonly Row[]) => string,
): (body: string) => string | undefined {
  const headerLines = header.split("\n").length;
  const columns = columnsOf(header);
  return (body) => {
    if (body === "\n") {
      return undefined;
    }
    const rows: Row[] = [];
    if (body.startsWith(`\n${header}\n`) && body.endsWith("\n")) {
      const lines = body.split("\n").slice(headerLines + 1, -1);
      const cells = lines.map(rowCells);
      const line = (row: number): number => row + headerLines + 1;
      const faulty = rowFault(columns, cells);
      if (faulty !== undefined) {
        return `line ${line(faulty.row)} ${faulty.fault}`;
      }
      for (const [index, rowOfCells] of cells.entries()) {
        const row = parseRow(rowOfCells, KEY_SPAN.exec(rowOfCells[0] ?? "")?.[1] ?? "");
        if (typeof row === "string") {
          return `line ${line(index)} ${row}`;
        }
        rows.push(row);
      }
    }
    return renderedMismatch(body, `\n${renderRows(rows)}\n`);
  };
}
