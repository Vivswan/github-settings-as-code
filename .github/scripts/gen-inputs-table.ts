/**
 * The inputs table of docs/reference/inputs.md: one row per input declaration, rendered as a generated region so a
 * marker moved over authored text is refused instead of regenerated over. The page's outputs list is gen-docs.ts's
 * region, so two generators write into the page.
 */

import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { INPUT_DECLS, type InputDecl } from "../../src/flows/inputs.js";
import { renderTable, tableBody, tableFault } from "../../src/report/markdown.js";
import { block, GeneratedRegion } from "./lib/generated-regions.js";
import { type GeneratedFiles, regenerateFiles } from "./lib/region-driver.js";

const ROOT = join(import.meta.dir, "..", "..");

export const INPUTS_PAGE_PATH = "docs/reference/inputs.md";

const INPUTS_TABLE_HEADER =
  "| name | description | required | default |\n| --- | --- | --- | --- |";

/** The declarations the table renders from, by input name. */
type Inputs = Readonly<Record<string, Pick<InputDecl, "description" | "default">>>;

/** Why a description cannot sit in its cell: the cell is HTML, so a tag would be swallowed by the page's renderer. */
function descriptionFault(text: string): string | undefined {
  return text.includes("<") ? 'holds a "<", which the cell would read as an HTML tag' : undefined;
}

/** The default as the table shows it: in a code span, the empty string as `""`. */
function defaultSpan(value: string): string {
  return `\`${value === "" ? '""' : value}\``;
}

function inputsCells(inputs: Inputs): ReadonlyArray<readonly string[]> {
  return Object.entries(inputs).map(([name, decl]) => {
    const fault = descriptionFault(decl.description);
    if (fault !== undefined) {
      throw new Error(`gen-inputs-table: the "${name}" description ${fault}`);
    }
    return [`\`${name}\``, `<p>${decl.description}</p>`, "`false`", defaultSpan(decl.default)];
  });
}

/** The table rule is the author's to meet, so a description that would break its row stops the build naming it. */
export function renderInputsTable(inputs: Inputs): string {
  const cells = inputsCells(inputs);
  const fault = tableFault(INPUTS_TABLE_HEADER, cells, "cells");
  if (fault !== undefined) {
    throw new Error(`gen-inputs-table: ${fault}`);
  }
  return renderTable(INPUTS_TABLE_HEADER, cells);
}

const NAME_SPAN = /^`([a-z][a-z0-9-]*)`$/;
// The dotAll flag is for the two Unicode line separators cellFault() admits inside a cell.
const DESCRIPTION_CELL = /^<p>(.*)<\/p>$/s;
const DEFAULT_SPAN = /^`(.*)`$/s;

/** A row read back to the declaration it renders from; every input is optional, so the required cell is fixed. */
function inputRow(cells: readonly string[]): Result<readonly [string, Inputs[string]], string> {
  const name = NAME_SPAN.exec(cells[0] ?? "")?.[1];
  const description = DESCRIPTION_CELL.exec(cells[1] ?? "")?.[1];
  const value = DEFAULT_SPAN.exec(cells[3] ?? "")?.[1];
  if (name === undefined) {
    return err("does not open with an input name in a code span");
  }
  if (description === undefined) {
    return err("has no paragraph-wrapped description in its second cell");
  }
  const fault = descriptionFault(description);
  if (fault !== undefined) {
    return err(`${fault}, which the renderer refuses`);
  }
  if (cells[2] !== "`false`") {
    return err("does not show `false` in its required cell");
  }
  if (value === undefined) {
    return err("has no default in a code span in its fourth cell");
  }
  return ok([name, { description, default: value === '""' ? "" : value }]);
}

const parseInputsTable = tableBody(INPUTS_TABLE_HEADER, "cells", inputRow);

export const INPUTS_PAGES: GeneratedFiles = {
  [INPUTS_PAGE_PATH]: {
    regions: [
      GeneratedRegion.of<Inputs>({
        name: "inputs-table",
        placement: { kind: "under-heading", heading: "## Inputs" },
        data: () => INPUT_DECLS,
        render: block(renderInputsTable),
        parse: (body) => parseInputsTable(body).map((rows) => Object.fromEntries(rows)),
      }),
    ],
  },
};

if (import.meta.main) {
  regenerateFiles("gen-inputs-table", INPUTS_PAGES, ROOT);
}
