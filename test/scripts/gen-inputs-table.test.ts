import { describe, expect, test } from "bun:test";
import { renderInputsTable } from "../../.github/scripts/gen-inputs-table.js";

describe("the inputs table", () => {
  test("one row per declaration: the name and default in code spans, the description in a paragraph, an empty default as two quotes", () => {
    // The page's only other reader is a person; a respelled cell would drift unseen between regenerations of a changed declaration.
    expect(
      renderInputsTable({
        token: { description: "The token to act with.", default: "" },
        mode: { description: "Either `apply` or `check`.", default: "apply" },
      }),
    ).toBe(
      [
        "| name | description | required | default |",
        "|---|---|---|---|",
        '| `token` | <p>The token to act with.</p> | `false` | `""` |',
        "| `mode` | <p>Either `apply` or `check`.</p> | `false` | `apply` |",
      ].join("\n"),
    );
  });

  test('a description holding "<" or "|" is refused, since the cell would read a tag or split its row', () => {
    // The page's renderer swallows an HTML tag inside the cell; nothing else on the page would notice.
    expect(() =>
      renderInputsTable({ repos: { description: "the <owner>/name", default: "" } }),
    ).toThrow('gen-inputs-table: the "repos" description holds a "<"');
    expect(() => renderInputsTable({ repos: { description: "a | b", default: "" } })).toThrow(
      'gen-inputs-table: row 1 of the table cell 2 is blank or contains "|" or a line break',
    );
  });
});
