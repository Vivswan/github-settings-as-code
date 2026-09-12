/**
 * collectingIo and silentIo, and the redaction the collecting one applies:
 * captured text is masked like the action's log, so a library caller that
 * prints the collected lines cannot leak a registered value.
 */

import { describe, expect, test } from "bun:test";
import { collectingIo, redactRanges, silentIo } from "../../src/io.js";

describe("collectingIo", () => {
  test("records annotations and log lines in order, the last value per output, and every summary block", () => {
    const collected = collectingIo();
    collected.io.log("one");
    collected.io.annotate("warning", "two");
    collected.io.debug("dropped");
    collected.io.output("result", "clean");
    collected.io.output("result", "drift");
    collected.io.summary("## a");
    collected.io.summary("## b");
    collected.io.mask("o/priv");
    expect({
      lines: collected.lines,
      outputs: collected.outputs,
      summary: collected.summary,
      masked: [...collected.io.masked()],
    }).toEqual({
      lines: [{ line: "one" }, { level: "warning", line: "two" }],
      outputs: { result: "drift" },
      summary: ["## a", "## b"],
      masked: ["o/priv"],
    });
  });

  test("masks every registered value in each captured line, output, and summary block, overlaps included", () => {
    const collected = collectingIo();
    collected.io.log("before any mask: ghp_secret");
    collected.io.mask("ghp_secret");
    collected.io.mask("secret_tail");
    collected.io.log("token ghp_secret_tail in a log line");
    collected.io.annotate("error", "401 for ghp_secret");
    collected.io.debug("Authorization: token ghp_secret");
    collected.io.summary("# run by ghp_secret and secret_tail");
    collected.io.output("result", "failed ghp_secret");
    collected.io.output("skipped-sections", "teams");
    expect({
      lines: collected.lines,
      outputs: collected.outputs,
      summary: collected.summary,
    }).toEqual({
      // The first line predates the mask, as a runner's log does: masking is not retroactive.
      lines: [
        { line: "before any mask: ghp_secret" },
        { line: "token *** in a log line" },
        { level: "error", line: "401 for ***" },
      ],
      outputs: { result: "failed ***", "skipped-sections": "teams" },
      summary: ["# run by *** and ***"],
    });
  });
});

describe("redactRanges", () => {
  test.each<[string, string[], string, string]>([
    [
      "a prefix of another value",
      ["github_pat_ABC", "github_pat_ABCDEF"],
      "argument 'github_pat_ABCDEF' repeats github_pat_ABC",
      "argument '***' repeats ***",
    ],
    ["two values overlapping across the text", ["ABC", "BCD"], "x ABCD y", "x *** y"],
    ["an infix of another value", ["BC", "xABCDEy"], "see xABCDEy and BC", "see *** and ***"],
    ["two values touching end to start", ["ABC", "DEF"], "ABCDEF", "***"],
    ["separate occurrences of one value", ["ABC"], "ABC and ABC", "*** and ***"],
    ["a value absent from the line", ["ABC"], "nothing here", "nothing here"],
  ])("leaves no fragment of %s", (_case, masks, line, redacted) => {
    // Replacing one value after another would leave "***D" for the overlap and
    // "***DEF" for the prefix; the ranges are merged in the original text instead.
    expect(redactRanges(line, new Set(masks))).toBe(redacted);
  });

  test("an empty registered value masks nothing", () => {
    expect(redactRanges("plain text", new Set(["", "text"]))).toBe("plain ***");
  });
});

describe("silentIo", () => {
  test("drops every channel and keeps a registry of its own per call", () => {
    const first = silentIo();
    const second = silentIo();
    first.log("x");
    first.annotate("error", "y");
    first.mask("o/priv");
    expect([...first.masked()]).toEqual(["o/priv"]);
    expect([...second.masked()]).toEqual([]);
  });
});
