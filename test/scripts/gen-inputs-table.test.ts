import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INPUTS_PAGE_PATH,
  INPUTS_PAGES,
  renderInputsTable,
} from "../../.github/scripts/gen-inputs-table.js";
import { regionBounds } from "../../.github/scripts/lib/generated-regions.js";
import { regenerateFile } from "../../.github/scripts/lib/region-driver.js";
import { ROOT } from "../root.js";

const page = readFileSync(join(ROOT, INPUTS_PAGE_PATH), "utf8");
const { begin, end } = regionBounds(page, "inputs-table", "html");
const [intro, body, tail] = [
  page.slice(0, begin[1]),
  page.slice(begin[1], end[0]),
  page.slice(end[0]),
];
const regenerate = (text: string): string => regenerateFile(INPUTS_PAGES, INPUTS_PAGE_PATH, text);
/** The seal's refusal of the inputs-table region, naming the line below the BEGIN marker. */
const refusal = (lineBelowBegin: number): RegExp =>
  new RegExp(
    `^the inputs-table region in docs/reference/inputs.md encloses content .*\\(line ${lineBelowBegin} `,
  );

describe("the inputs table region", () => {
  test("the committed page regenerates to itself and a fresh marker pair renders the table", () => {
    expect(regenerate(page)).toBe(page);
    expect(regenerate(`${intro}\n${tail}`)).toBe(page);
  });

  /** A parse that checked only the cell count let an authored four-cell row through; each shape is placed where a moved marker would swallow it. */
  test.each([
    ["| authored prose", "a one-cell line"],
    ["| a | b |\n| --- | --- |\n| 1 | 2 |", "a two-column table"],
    [
      "| Keep this warning | It is authored prose | do not erase | note |",
      "a four-cell row with bare cells",
    ],
  ])("%p between the markers is refused naming its line (%s)", (authored) => {
    const rows = body.split("\n").length - 2;
    expect(() => regenerate(`${intro}${body}${authored}\n${tail}`)).toThrow(refusal(rows + 1));
    expect(() => regenerate(`${intro}\n${authored}\n${tail}`)).toThrow(refusal(1));
  });

  test('a description holding "<" is refused on both sides, since the cell would read it as a tag', () => {
    // The page's renderer swallows an HTML tag inside the cell; nothing else on the page would notice.
    expect(() =>
      renderInputsTable({ repos: { description: "the <owner>/name", default: "" } }),
    ).toThrow('gen-inputs-table: the "repos" description holds a "<"');
    const tagged = body.replace("<p>The token", "<p>The <token>");
    expect(tagged).not.toBe(body);
    expect(() => regenerate(`${intro}${tagged}${tail}`)).toThrow(refusal(3));
  });
});
