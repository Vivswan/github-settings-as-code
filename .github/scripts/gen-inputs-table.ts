/**
 * The inputs table of docs/reference/inputs.md: one row per input declaration, rendered as a generated region the
 * generator overwrites on every run. The page's outputs list is gen-docs.ts's
 * region, so two generators write into the page.
 */

import { join } from "node:path";
import { INPUT_DECLS, type InputDecl } from "../../src/flows/inputs.js";
import { renderTable, tableFault } from "../../src/report/markdown.js";
import { runMain } from "./lib/entry.js";
import { markdownBlock } from "./lib/generated-regions.js";
import { type GeneratedFiles, regenerateFiles } from "./lib/region-driver.js";

const ROOT = join(import.meta.dir, "..", "..");

const INPUTS_PAGE_PATH = "docs/reference/inputs.md";

const INPUTS_TABLE_HEADER = "| name | description | required | default |\n|---|---|---|---|";

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

export const INPUTS_PAGES: GeneratedFiles = {
  [INPUTS_PAGE_PATH]: {
    regions: [
      {
        name: "inputs-table",
        placement: { kind: "under-heading", heading: "## Inputs" },
        render: () => markdownBlock(renderInputsTable(INPUT_DECLS)),
      },
    ],
  },
};

if (import.meta.main) {
  await runMain("gen-inputs-table", () => regenerateFiles("gen-inputs-table", INPUTS_PAGES, ROOT));
}
