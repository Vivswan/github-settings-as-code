import { describe, expect, test } from "bun:test";
import { collectingIo, silentIo } from "../../src/io.js";

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
