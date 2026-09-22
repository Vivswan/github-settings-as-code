import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INPUTS_PAGE_PATH, MARKER } from "../../.github/scripts/gen-inputs-table.js";
import { INPUT_DECLS } from "../../src/flows/inputs.js";
import { ROOT } from "../root.js";

/**
 * action-docs runs each description through a markdown renderer before it reaches the table cell, so prose action.yml
 * and the CLI help show verbatim can come out italicized (a paired "*" or "_"), as an ellipsis character ("..."), or
 * swallowed as an HTML tag ("<owner>"); nothing else on the page would notice. The region is pinned whole (the
 * heading, one row per declaration verbatim and in order, nothing else), the same shape gen-inputs-table.ts refuses
 * to regenerate over. A "|" and a "<" are the two characters the row comparison cannot catch: the renderer passes
 * both through, so the expected row carries the split cell or the raw tag too.
 */
test("the inputs table region is exactly action-docs's ASCII rendering of every declaration", () => {
  const page = readFileSync(join(ROOT, INPUTS_PAGE_PATH), "utf8");
  const parts = page.split(MARKER);
  expect(parts).toHaveLength(3);
  const region = parts[1] ?? "";
  const rows = Object.entries(INPUT_DECLS).map(
    ([name, decl]) =>
      `| \`${name}\` | <p>${decl.description}</p> | \`false\` | \`${decl.default === "" ? '""' : decl.default}\` |`,
  );
  expect(region.split("\n")).toEqual([
    "",
    "## Inputs",
    "",
    "| name | description | required | default |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ]);
  expect(region).toMatch(/^[\x20-\x7e\n]*$/);
  for (const [name, decl] of Object.entries(INPUT_DECLS)) {
    expect(decl.description, `the "${name}" description holds a "|" or a "<"`).not.toMatch(/[|<]/);
  }
});
