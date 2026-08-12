/**
 * Direct pins for loosen()'s own guarantees (src/sections/contract/module.ts).
 * The section suites cover it indirectly through every shape; these tests pin
 * the derivation rules themselves, including the loud-failure paths - and,
 * because cloneWith patches zod's internal def through a hand-mirrored view,
 * they are the tripwire that a zod-internal rename (element, innerType,
 * valueType, catchall) would otherwise turn into a silent no-op.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { loosen } from "../../src/sections/contract/module.js";

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
    const viaArray = loosen(z.array(z.object({ name: z.string() })));
    expect(viaArray.safeParse([{ name: "a", extra: 1 }]).success).toBe(true);
    const viaRecord = loosen(z.record(z.string(), z.object({ name: z.string() })));
    expect(viaRecord.safeParse({ key: { name: "a", extra: 1 } }).success).toBe(true);
  });

  test("the knobbed union is rewrapped with per-container issue paths", () => {
    const knob = z.union([
      z.array(z.object({ name: z.string() })),
      z.strictObject({
        undeclared: z.enum(["keep", "delete"]).optional(),
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
    expect(() => loosen(knob)).toThrow(/routed rewrap would silently drop/);
  });

  test("an unrecognized container type fails loudly instead of skipping the derivation", () => {
    expect(() => loosen(z.tuple([z.string()]))).toThrow(/unhandled schema type "tuple"/);
  });
});
