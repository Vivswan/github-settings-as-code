/**
 * What zod does not promise for open() and routed() (src/sections/shared/schema-helpers.ts), which every section's
 * runtime shape is built from.
 */

import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { SettingsFile } from "../../../src/index.js";
import { knobbed, open, routed, rule } from "../../../src/sections/shared/schema-helpers.js";
import { schemaNode } from "../../../src/sections/shared/schema-node.js";

const opennessOf = (schema: z.ZodType) => {
  const node = schemaNode(schema);
  return node.kind === "object" ? node.openness : node.kind;
};

describe("open()", () => {
  test("an undeclared key reaches the mapping's rule and survives in the parsed data", () => {
    const shape = open({ name: z.string() }).check(
      rule((value, ctx) => {
        if ((value as Record<string, unknown>).misplaced !== undefined) {
          ctx.addIssue({ code: "custom", path: ["misplaced"], message: "trap fired" });
        }
      }),
    );
    expect(shape.safeParse({ name: "a", extra: 1 }).data as unknown).toEqual({
      name: "a",
      extra: 1,
    });
    expect(shape.safeParse({ name: "a", misplaced: 1 }).error?.issues).toEqual([
      expect.objectContaining({ path: ["misplaced"], message: "trap fired" }),
    ]);
  });

  test("the walks tell open() from z.looseObject and z.strictObject, through .meta() and .check() clones", () => {
    const opened = open({ name: z.string() });
    expect(opennessOf(opened)).toBe("declared");
    expect(opennessOf(opened.meta({ id: "OpenTestEntry" }))).toBe("declared");
    expect(opennessOf(opened.check(rule(() => {})))).toBe("declared");
    expect(opennessOf(z.looseObject({ name: z.string() }))).toBe("open");
    expect(opennessOf(z.strictObject({ name: z.string() }))).toBe("strict");
  });

  test("the inferred type is closed: no index signature, so an excess property is a type error", () => {
    const opened = open({ name: z.string() });
    expectTypeOf<z.infer<typeof opened>>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<z.infer<typeof opened>>().not.toHaveProperty("undeclared");
  });
});

describe("the exported SettingsFile parser", () => {
  test("the root stays a strip object: an unknown top-level key is dropped, not passed through", () => {
    // Which top-level keys a document may carry is validateSettingsDoc's question (src/engine/orchestrate.ts).
    expect(SettingsFile.parse({ extra: 1 })).toEqual({});
    expect(SettingsFile.parse({ _undeclared: "keep", extra: 1 })).toEqual({ _undeclared: "keep" });
  });

  test("parses a section as the action does: an undeclared key survives, a refused key fails by name", () => {
    expect(SettingsFile.parse({ labels: [{ name: "a", extra: 1 }] }) as unknown).toEqual({
      labels: [{ name: "a", extra: 1 }],
    });
    const refused = SettingsFile.safeParse({ actions: { selected_actions_url: "x" } });
    expect(refused.error?.issues.map((issue) => issue.path)).toEqual([
      ["actions", "selected_actions_url"],
    ]);
  });
});

describe("routed()", () => {
  const entry = open({ name: z.string() }).meta({ id: "RoutedTestEntry" });

  test("routes each container form to its schema, so a failing entry keeps its path", () => {
    const runtime = routed(knobbed(entry));
    expect(runtime.safeParse([{ name: "a" }]).success).toBe(true);
    expect(runtime.safeParse({ entries: [{ name: "a" }] }).success).toBe(true);
    expect(runtime.safeParse([{ name: 1 }]).error?.issues[0]?.path).toEqual([0, "name"]);
    expect(runtime.safeParse({ entries: [{ name: 1 }] }).error?.issues[0]?.path).toEqual([
      "entries",
      0,
      "name",
    ]);
  });

  test("routes a knob nested in an entry, so the nested entry keeps its path too", () => {
    const nested = open({ name: z.string(), items: knobbed(entry).optional() }).meta({
      id: "RoutedTestHost",
    });
    const runtime = routed(knobbed(nested));
    expect(
      runtime.safeParse([{ name: "host", items: { entries: [{ name: 1 }] } }]).error?.issues[0]
        ?.path,
    ).toEqual([0, "items", "entries", 0, "name"]);
  });

  test.each([
    ["a .meta() clone", (knob: z.ZodType) => knob.meta({ description: "x" })],
    ["a .describe() clone", (knob: z.ZodType) => knob.describe("x")],
  ])("%s of the union is still routed, so a failing entry keeps its path", (_name, clone) => {
    expect(
      routed(clone(knobbed(entry))).safeParse({ entries: [{ name: 1 }] }).error?.issues[0]?.path,
    ).toEqual(["entries", 0, "name"]);
  });

  test("refuses a union no helper minted, and a knob union carrying its own refinement", () => {
    expect(() =>
      routed(z.union([z.array(entry), z.strictObject({ entries: z.array(entry) })])),
    ).toThrow(
      new Error(
        "BUG: routed(): not a union knobbed(), nestedKnobbed(), or layeredList() minted - route the union the helper returned",
      ),
    );
    expect(() => routed(knobbed(entry).check(rule(() => {})))).toThrow(
      new Error(
        "BUG: routed(): a knobbed-section union carries its own refinements, which the routed rewrap would silently drop - attach them to the entry array or the wrapper",
      ),
    );
  });
});
