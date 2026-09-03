import { describe, expect, test } from "bun:test";
import { type Delta, deltas, phantomKeys, renderDelta, subsetDiff } from "../../src/engine/diff.js";

describe("deltas", () => {
  test("structures every divergence of an object: scalar mismatch, absent key, nested path, and the tolerated empties", () => {
    const desired = {
      a: 1,
      gone: "x",
      nested: { b: "y", deeper: { c: true } },
      empty: "",
      nil: null,
      list: [1],
    };
    const live = { a: 2, nested: { b: "z", deeper: {} }, empty: null, extra: 1, list: "no" };
    expect(deltas(desired, live)).toEqual([
      { kind: "mismatch", path: ["a"], desired: 1, live: 2 },
      { kind: "phantom", path: ["gone"], desired: "x" },
      { kind: "mismatch", path: ["nested", "b"], desired: "y", live: "z" },
      { kind: "phantom", path: ["nested", "deeper", "c"], desired: true },
      { kind: "mismatch", path: ["list"], desired: [1], live: "no" },
    ]);
  });

  test.each<[name: string, delta: Delta, line: string]>([
    ["scalar mismatch", { kind: "mismatch", path: ["a"], desired: 1, live: 2 }, "x.a: 1 != 2"],
    [
      "object where live has a scalar",
      { kind: "mismatch", path: ["o"], desired: { k: 1 }, live: 3 },
      "x.o: expected object, live has 3",
    ],
    [
      "list where live has none",
      { kind: "mismatch", path: [], desired: [1], live: null },
      "x: expected list, live has null",
    ],
    [
      "declared empty, live filled",
      { kind: "mismatch", path: ["e"], desired: null, live: "v" },
      'x.e: expected empty, live has "v"',
    ],
    [
      "phantom scalar",
      { kind: "phantom", path: ["colr"], desired: "ff0000" },
      'x.colr: declared "ff0000" but the API response has no such field (new or write-only field?)',
    ],
    [
      "phantom object",
      { kind: "phantom", path: ["o"], desired: {} },
      "x.o: expected object, live has undefined",
    ],
    [
      "missing keyed item",
      { kind: "missing", path: ["rules", { key: "deletion" }], desired: {}, match: "key" },
      "x.rules[deletion]: missing live",
    ],
    [
      "undeclared keyed item",
      { kind: "undeclared", path: ["rules", { key: "update" }], live: {}, match: "key" },
      "x.rules[update]: present live but not declared",
    ],
    [
      "missing shape item",
      { kind: "missing", path: ["actors", 1], desired: { id: 2 }, match: "shape" },
      'x.actors[1]: no matching live entry for {"id":2}',
    ],
    [
      "undeclared shape item",
      { kind: "undeclared", path: ["actors"], live: { id: 9 }, match: "shape" },
      'x.actors: live entry not declared: {"id":9}',
    ],
    [
      "missing value",
      { kind: "missing", path: ["topics"], desired: "a", match: "value" },
      'x.topics: missing "a"',
    ],
    [
      "undeclared value",
      { kind: "undeclared", path: ["topics"], live: "c", match: "value" },
      'x.topics: unexpected "c"',
    ],
  ])("renders a %s delta as its drift line", (_name, delta, line) => {
    expect(renderDelta("x", delta)).toBe(line);
  });

  test("a declared matchBy pairs a list by its key at any type multiplicity, and the pairing is exact", () => {
    const desired = {
      reviewers: [
        { type: "User", id: 1 },
        { type: "User", id: 2 },
      ],
    };
    const live = {
      reviewers: [
        { type: "User", id: 2 },
        { type: "User", id: 1, extra: true },
      ],
    };
    // Repeated types defeat the legacy sniffing (shape pairing still matches here)...
    expect(deltas(desired, live)).toEqual([]);
    // ...and a declared key pairs by id, so a divergent field under a paired id is a mismatch.
    const drifted = {
      reviewers: [
        { type: "User", id: 1 },
        { type: "Team", id: 2 },
      ],
    };
    expect(deltas(drifted, live, { matchBy: { reviewers: "id" } })).toEqual([
      {
        kind: "mismatch",
        path: ["reviewers", { key: "2" }, "type"],
        desired: "Team",
        live: "User",
      },
    ]);
  });

  test("with matchBy declared, an undeclared list never sniffs a type key: unique types pair by shape", () => {
    const desired = { rules: [{ type: "deletion", extra: 1 }] };
    const live = { rules: [{ type: "deletion" }, { type: "update" }] };
    expect(subsetDiff(desired, live, "x")).toEqual([
      "x.rules[deletion].extra: declared 1 but the API response has no such field (new or write-only field?)",
      "x.rules[update]: present live but not declared",
    ]);
    expect(deltas(desired, live, { matchBy: {} }).map((d) => renderDelta("x", d))).toEqual([
      'x.rules[0]: no matching live entry for {"type":"deletion","extra":1}',
      'x.rules: live entry not declared: {"type":"deletion"}',
      'x.rules: live entry not declared: {"type":"update"}',
    ]);
  });

  test.each<[defect: string, desired: unknown, live: unknown, message: RegExp]>([
    ["a live item without the key", [{ id: 1 }], [{ nope: 1 }], /live item carries no such key/],
    ["a desired item without the key", [{ nope: 1 }], [], /desired item carries no such key/],
    ["a repeated live key", [{ id: 1 }], [{ id: 1 }, { id: 1 }], /live list repeats "1"/],
    ["a repeated desired key", [{ id: 1 }, { id: 1 }], [], /declared list repeats "1"/],
  ])(
    "a matchBy list with %s is a declaration bug, named by list and key",
    (_defect, desired, live, message) => {
      expect(() =>
        deltas({ items: desired }, { items: live }, { matchBy: { items: "id" } }),
      ).toThrow(message);
      expect(() =>
        deltas({ items: desired }, { items: live }, { matchBy: { items: "id" } }),
      ).toThrow(/list "items" by "id"/);
    },
  );
});

describe("subsetDiff", () => {
  test.each<[branch: string, desired: unknown, live: unknown, lines: string[]]>([
    [
      "object where live is a scalar",
      { o: { k: 1 } },
      { o: 3 },
      ["x.o: expected object, live has 3"],
    ],
    [
      "object where live is absent",
      { o: { k: 1 } },
      {},
      ["x.o: expected object, live has undefined"],
    ],
    ["list where live is a scalar", { l: [1] }, { l: "no" }, ['x.l: expected list, live has "no"']],
    ["list where live is absent", { l: [1] }, {}, ["x.l: expected list, live has undefined"]],
    ["declared null, live filled", { e: null }, { e: "v" }, ['x.e: expected empty, live has "v"']],
    [
      "absent scalar",
      { colr: "ff0000" },
      {},
      [
        'x.colr: declared "ff0000" but the API response has no such field (new or write-only field?)',
      ],
    ],
    [
      "keyed missing entry",
      { rules: [{ type: "a" }] },
      { rules: [] },
      ["x.rules[a]: missing live"],
    ],
    [
      "keyed entry with a nested mismatch",
      { rules: [{ type: "a", p: 1 }] },
      { rules: [{ type: "a", p: 2 }] },
      ["x.rules[a].p: 1 != 2"],
    ],
    [
      "shape-matched list, missing and leftover",
      { actors: [{ id: 1 }, { id: 2 }] },
      { actors: [{ id: 2 }, { id: 3 }] },
      [
        'x.actors[0]: no matching live entry for {"id":1}',
        'x.actors: live entry not declared: {"id":3}',
      ],
    ],
    [
      "scalar list, both directions",
      { t: ["a", "b"] },
      { t: ["b", "c"] },
      ['x.t: missing "a"', 'x.t: unexpected "c"'],
    ],
    [
      "scalar list, repeated values count once",
      { t: ["a", "a"] },
      { t: ["c", "c"] },
      ['x.t: missing "a"', 'x.t: unexpected "c"'],
    ],
  ])("renders the %s branch as before", (_branch, desired, live, lines) => {
    expect(subsetDiff(desired, live, "x")).toEqual(lines);
  });
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
  test("excludes null and empty-string values (deltas tolerates them)", () => {
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
