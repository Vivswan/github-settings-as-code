import { describe, expect, test } from "bun:test";
import { type Diagnostic, parseDiagnostics } from "../../.github/scripts/lib/tsc-diagnostics.js";

const TRIPWIRE_MESSAGE =
  "Type '\"GET /repos/{owner}/{repo}/merge-queue\"' does not satisfy the constraint 'never'.";

describe("parseDiagnostics", () => {
  test.each<[label: string, output: string, diagnostics: Diagnostic[]]>([
    [
      "--pretty false diagnostic lines",
      [
        `src/upstream-gaps/merge-queue.ts(12,34): error TS2344: ${TRIPWIRE_MESSAGE}`,
        "src/engine/diff.ts(7,3): error TS2322: Type 'string' is not assignable to type 'number'.",
        "",
      ].join("\n"),
      [
        {
          file: "src/upstream-gaps/merge-queue.ts",
          line: 12,
          column: 34,
          code: 2344,
          message: TRIPWIRE_MESSAGE,
        },
        {
          file: "src/engine/diff.ts",
          line: 7,
          column: 3,
          code: 2322,
          message: "Type 'string' is not assignable to type 'number'.",
        },
      ],
    ],
    [
      "CRLF line endings",
      "src/upstream-gaps/a.ts(1,1): error TS2344: boom\r\n",
      [{ file: "src/upstream-gaps/a.ts", line: 1, column: 1, code: 2344, message: "boom" }],
    ],
  ])("parses %s", (_label, output, expected) => {
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(unparsed).toEqual([]);
    expect(diagnostics).toEqual(expected);
  });

  test("attaches indented continuation lines to the diagnostic above them", () => {
    // Real tsgo 7.0.2 --pretty false output: a chained error continues on indented lines under the diagnostic.
    const output = [
      "src/chain.ts(3,29): error TS2345: Argument of type '{ a: { b: string; }; }' is not assignable to parameter of type '{ a: { b: number; }; }'.",
      "  The types of 'a.b' are incompatible between these types.",
      "    Type 'string' is not assignable to type 'number'.",
      "src/other.ts(9,1): error TS2304: Cannot find name 'nope'.",
    ].join("\n");
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(unparsed).toEqual([]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]?.code).toBe(2345);
    expect(diagnostics[0]?.message).toBe(
      [
        "Argument of type '{ a: { b: string; }; }' is not assignable to parameter of type '{ a: { b: number; }; }'.",
        "  The types of 'a.b' are incompatible between these types.",
        "    Type 'string' is not assignable to type 'number'.",
      ].join("\n"),
    );
    expect(diagnostics[1]?.message).toBe("Cannot find name 'nope'.");
  });

  test("lines that are neither a diagnostic nor its continuation stay unparsed, and end the diagnostic above them", () => {
    const output = [
      "error TS5112: Option 'project' cannot be mixed with source files on a command line.",
      "src/upstream-gaps/a.ts(1,1): error TS2344: boom",
      "some stray crash line",
      "  looks like a continuation, but the stray line above ended the diagnostic",
    ].join("\n");
    const { diagnostics, unparsed } = parseDiagnostics(output);
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["boom"]);
    expect(unparsed).toEqual([
      "error TS5112: Option 'project' cannot be mixed with source files on a command line.",
      "some stray crash line",
      "  looks like a continuation, but the stray line above ended the diagnostic",
    ]);
  });
});
