/**
 * cloneWith patches zod's internal def through a hand-mirrored view, so these are the tripwire a zod-internal rename (element, innerType, valueType,
 * catchall) would otherwise turn into a silent no-op.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { checksReportingBesideFailures, loosen } from "../../src/sections/contract/module.js";

describe("loosen", () => {
  test("strip objects become passthrough, and their superRefines see unknown keys", () => {
    const authored = z.object({ name: z.string() }).superRefine((value, ctx) => {
      if ((value as Record<string, unknown>).misplaced !== undefined) {
        ctx.addIssue({ code: "custom", path: ["misplaced"], message: "trap fired" });
      }
    });
    // The authored strip parse hides the unknown key from the check...
    expect(authored.safeParse({ name: "a", misplaced: 1 }).success).toBe(true);
    const runtime = loosen(authored);
    // ...the loosened runtime shape passes it through AND the check survives.
    expect(runtime.safeParse({ name: "a", extra: 1 }).success).toBe(true);
    const trapped = runtime.safeParse({ name: "a", misplaced: 1 });
    expect(trapped.success).toBe(false);
    expect(trapped.error?.issues[0]?.message).toBe("trap fired");
  });

  test("strictObject stays strict, nested inside a loosened tree", () => {
    const runtime = loosen(z.object({ nested: z.strictObject({ app: z.string() }).optional() }));
    expect(runtime.safeParse({ nested: { app: "x" }, extra: 1 }).success).toBe(true);
    const rejected = runtime.safeParse({ nested: { app: "x", typo: 1 } });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues[0]?.path).toEqual(["nested"]);
  });

  test("array elements and record values are loosened (the def-surgery tripwire)", () => {
    // The parsed DATA carries the unknown key: a strip object would parse the same input while dropping it, so success alone proves nothing.
    const viaArray = loosen(z.array(z.object({ name: z.string() })));
    expect(viaArray.safeParse([{ name: "a", extra: 1 }])).toEqual({
      success: true,
      data: [{ name: "a", extra: 1 }],
    });
    const viaRecord = loosen(z.record(z.string(), z.object({ name: z.string() })));
    expect(viaRecord.safeParse({ key: { name: "a", extra: 1 } })).toEqual({
      success: true,
      data: { key: { name: "a", extra: 1 } },
    });
  });

  test("the knobbed union is rewrapped with per-container issue paths", () => {
    const knob = z.union([
      z.array(z.object({ name: z.string() })),
      z.strictObject({
        _undeclared: z.enum(["keep", "delete"]).optional(),
        entries: z.array(z.object({ name: z.string() })),
      }),
    ]);
    const runtime = loosen(knob);
    expect(runtime.safeParse([{ name: "a" }]).success).toBe(true);
    expect(runtime.safeParse({ entries: [{ name: "a" }] }).success).toBe(true);
    expect(runtime.safeParse([{ name: 1 }]).error?.issues[0]?.path).toEqual([0, "name"]);
    expect(runtime.safeParse({ entries: [{ name: 1 }] }).error?.issues[0]?.path).toEqual([
      "entries",
      0,
      "name",
    ]);
  });

  test("a knobbed union carrying its own refinement fails loudly instead of dropping it", () => {
    const knob = z
      .union([
        z.array(z.object({ name: z.string() })),
        z.strictObject({ entries: z.array(z.object({ name: z.string() })) }),
      ])
      .superRefine(() => {});
    expect(() => loosen(knob)).toThrow(
      new Error(
        "BUG: loosen(): a knobbed-section union carries its own refinements, which the routed rewrap would silently drop - attach them to the entry array or the wrapper",
      ),
    );
  });

  test("an unrecognized container type fails loudly instead of skipping the derivation", () => {
    expect(() => loosen(z.tuple([z.string()]))).toThrow(
      new Error(
        'BUG: loosen(): unhandled schema type "tuple" - teach loosen() its runtime derivation before authoring it in src/schema.ts',
      ),
    );
  });
});

describe("every check reports beside a failed nested value", () => {
  const pair = z
    .object({ mode: z.enum(["a", "b"]).optional(), list: z.array(z.string()).optional() })
    .superRefine((value, ctx) => {
      if (value.list !== undefined && value.mode !== "a") {
        ctx.addIssue({ code: "custom", path: ["list"], message: "list needs mode a" });
      }
    });

  test("an object's own rule runs when a sibling property failed, and its finding keeps its path", () => {
    const issues = loosen(pair).safeParse({ mode: "c", list: ["x"] }).error?.issues;
    expect(issues?.map((issue) => [issue.path, issue.message])).toEqual([
      [["mode"], expect.stringMatching(/^Invalid option/)],
      [["list"], "list needs mode a"],
    ]);
  });

  test("a rule's finding under the failed path is dropped: the shape's issue there is the report", () => {
    const sweep = z.object({ list: z.array(z.string()) }).superRefine((value, ctx) => {
      for (const key of Object.keys(value.list)) {
        ctx.addIssue({ code: "custom", path: ["list", key], message: "swept" });
      }
    });
    const issues = loosen(sweep).safeParse({ list: "yes" }).error?.issues;
    expect(issues?.map((issue) => [issue.path, issue.message])).toEqual([
      [["list"], expect.stringMatching(/expected array/)],
    ]);
  });

  test("a rule that throws on the raw value beside a failure keeps what it found first; without a failure the throw propagates", () => {
    const throwing = z
      .object({ flag: z.boolean().optional(), list: z.array(z.string()) })
      .superRefine((value, ctx) => {
        if (value.flag === true) {
          ctx.addIssue({ code: "custom", path: ["flag"], message: "flag found first" });
        }
        value.list.map((item) => item.toLowerCase());
        throw new Error("rule bug");
      });
    const issues = loosen(throwing).safeParse({ flag: true, list: [1] }).error?.issues;
    expect(issues?.map((issue) => [issue.path, issue.message])).toEqual([
      [["list", 0], expect.stringMatching(/expected string/)],
      [["flag"], "flag found first"],
    ]);
    expect(() => loosen(throwing).safeParse({ list: ["ok"] })).toThrow(new Error("rule bug"));
  });

  test("a node refused as a whole does not run its own rules on the foreign value", () => {
    let ran = false;
    const watched = z.object({ name: z.string() }).superRefine(() => {
      ran = true;
    });
    const issues = loosen(watched).safeParse("not a mapping").error?.issues;
    expect(issues?.map((issue) => issue.path)).toEqual([[]]);
    expect(ran).toBe(false);
  });

  test("a check's own when predicate still decides: one answering false keeps its body uncalled", () => {
    let ran = false;
    const gated = z.check(() => {
      ran = true;
    });
    gated._zod.def.when = () => false;
    const shape = z.object({ name: z.string() }).check(gated);
    expect(loosen(shape).safeParse({ name: "a" }).success).toBe(true);
    expect(loosen(shape).safeParse({ name: 1 }).success).toBe(false);
    expect(ran).toBe(false);
  });

  test("a check composed onto the loosened shape reports beside a failure through checksReportingBesideFailures", () => {
    const composed = loosen(z.array(z.object({ name: z.string() }))).superRefine((value, ctx) => {
      if (Array.isArray(value) && value.length > 1) {
        ctx.addIssue({ code: "custom", path: [1], message: "second entry" });
      }
    });
    expect(composed.safeParse([{ name: 1 }, { name: "b" }]).error?.issues).toHaveLength(1);
    const issues = checksReportingBesideFailures(composed).safeParse([{ name: 1 }, { name: "b" }])
      .error?.issues;
    expect(issues?.map((issue) => issue.path)).toEqual([[0, "name"], [1]]);
  });

  test("a rule's own finding is not a failure: the list-level rule still runs over an entry with one", () => {
    const list = z.array(pair).superRefine((entries, ctx) => {
      if (entries.length > 1) {
        ctx.addIssue({ code: "custom", message: "at most one entry" });
      }
    });
    const issues = loosen(list).safeParse([{ list: ["x"] }, { mode: "a" }]).error?.issues;
    expect(issues?.map((issue) => issue.message)).toEqual([
      "list needs mode a",
      "at most one entry",
    ]);
  });
});
