import { describe, expect, test } from "bun:test";
import { phantomKeys, subsetDiff } from "../../src/engine/diff.js";

describe("subsetDiff", () => {
  test("ignores undeclared live keys", () => {
    expect(subsetDiff({ a: 1 }, { a: 1, b: 2 }, "x")).toEqual([]);
  });
  test("reports scalar drift", () => {
    expect(subsetDiff({ a: 1 }, { a: 2 }, "x")).toEqual(["x.a: 1 != 2"]);
  });
  test("empty string equals live null", () => {
    expect(subsetDiff({ d: "" }, { d: null }, "x")).toEqual([]);
  });
  test("rules match by type, order-insensitive", () => {
    const desired = [{ type: "deletion" }, { type: "update" }];
    const live = [{ type: "update" }, { type: "deletion" }];
    expect(subsetDiff(desired, live, "rules")).toEqual([]);
  });
  test("undeclared live rule is drift", () => {
    const desired = [{ type: "deletion" }];
    const live = [{ type: "deletion" }, { type: "update" }];
    expect(subsetDiff(desired, live, "rules")).toEqual([
      "rules[update]: present live but not declared",
    ]);
  });
  test("scalar lists compare as sets", () => {
    expect(subsetDiff(["a", "b"], ["b", "a"], "x")).toEqual([]);
    expect(subsetDiff(["a"], ["a", "c"], "x")).toEqual(['x: unexpected "c"']);
  });
});

describe("phantomKeys", () => {
  test("names declared keys the live object does not carry", () => {
    expect(phantomKeys({ colr: "ff0000", description: "x" }, { description: "x" })).toEqual([
      "colr",
    ]);
  });
  test("excludes null and empty-string values (subsetDiff tolerates them)", () => {
    expect(phantomKeys({ a: null, b: "", c: undefined }, {})).toEqual([]);
  });
  test("a live key holding any value is not phantom, even when it differs", () => {
    expect(phantomKeys({ state: "open" }, { state: "closed" })).toEqual([]);
    expect(phantomKeys({ state: "open" }, { state: null })).toEqual([]);
  });
  test("a non-object live value yields nothing", () => {
    expect(phantomKeys({ a: 1 }, null)).toEqual([]);
    expect(phantomKeys({ a: 1 }, [])).toEqual([]);
  });
});
