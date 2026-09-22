import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INPUTS_PAGE_PATH, MARKER, regionProblem } from "../../.github/scripts/gen-inputs-table.js";
import { ROOT } from "../root.js";

const page = readFileSync(join(ROOT, INPUTS_PAGE_PATH), "utf8");
const [intro, region, tail] = page.split(MARKER) as [string, string, string];
const pageLine = (text: string, needle: string): number =>
  text.slice(0, text.indexOf(needle)).split("\n").length;
const refusal = (line: number): RegExp =>
  new RegExp(
    `^line ${line} of docs/reference/inputs.md .*not a line of a rendered inputs table; move the markers back`,
  );

/** action-docs itself accepts every one of these pages and rewrites the region; only the guard tells them apart. */
test("the committed page and a fresh marker pair pass; a marker moved over prose is refused naming the line, a lone marker naming the count", () => {
  expect(regionProblem(page)).toBeNull();
  expect(regionProblem(`${intro}${MARKER}\n${MARKER}${tail}`)).toBeNull();
  const paragraphEnd = tail.indexOf("\n\n## ");
  const swallowing = `${intro}${MARKER}${region}${tail.slice(0, paragraphEnd)}\n${MARKER}${tail.slice(paragraphEnd)}`;
  // The first swallowed line is the first blank after the rows: a rendering's only blank there is the line before the
  // closing marker, and the moved marker leaves the page's own blank lines and its closing div in the region.
  expect(regionProblem(swallowing)).toMatch(refusal(pageLine(swallowing, "\n\n</div>")));
  expect(regionProblem(`${intro}${MARKER}${region}${tail}`)).toMatch(
    /exactly two .* markers, found 1/,
  );
  expect(regionProblem(`${intro}${MARKER}${region}${MARKER}${MARKER}${tail}`)).toMatch(/found 3/);
  // action-docs replaces only the opening marker of an adjacent pair, leaving three on the page.
  expect(regionProblem(`${intro}${MARKER}${MARKER}${tail}`)).toMatch(
    new RegExp(
      `^the closing .* marker on line ${pageLine(intro, "<div v-pre>") + 2} of .* must start its own line`,
    ),
  );
});

/** A guard that checked only the `| ` prefix let action-docs erase the first two, and one that counted cells the
 * third: an authored line that looks like a row, an authored table of another width, and an authored four-cell row
 * with bare cells. Each is placed where a moved marker would swallow it. */
test.each([
  ["| authored prose", "a one-cell line"],
  ["| a | b |\n| --- | --- |\n| 1 | 2 |", "a two-column table"],
  [
    "| Keep this warning | It is authored prose | do not erase | note |",
    "a four-cell row with bare cells",
  ],
])("%p between the markers is refused naming its line (%s)", (authored) => {
  const swallowing = `${intro}${MARKER}${region}${authored}\n${MARKER}${tail}`;
  expect(regionProblem(swallowing)).toMatch(refusal(pageLine(swallowing, authored)));
  const replacing = `${intro}${MARKER}\n${authored}\n${MARKER}${tail}`;
  expect(regionProblem(replacing)).toMatch(refusal(pageLine(replacing, authored)));
});

/** The check is one split per line, so a row of thousands of cells costs what its length costs; the four-cell regex
 * this replaced backtracked exponentially on exactly this row (CodeQL's inefficient-regular-expression alert). */
test("a 30-row table whose last row is malformed is refused naming that row, in linear time", () => {
  const rows = Array.from(
    { length: 29 },
    (_, i) => `| \`in${i}\` | <p>text</p> | \`false\` | \`""\` |`,
  );
  const malformed = `| \`_\` | ${" | `true` | `true` | `` | `_` |".repeat(5000)}`;
  const table = [
    "",
    "## Inputs",
    "",
    "| name | description | required | default |",
    "| --- | --- | --- | --- |",
    ...rows,
    malformed,
    "",
  ];
  const swallowing = `${intro}${MARKER}${table.join("\n")}${MARKER}${tail}`;
  const started = performance.now();
  const problem = regionProblem(swallowing);
  const elapsed = performance.now() - started;
  expect(problem).toMatch(refusal(pageLine(swallowing, malformed)));
  expect(elapsed).toBeLessThan(2000);
});
