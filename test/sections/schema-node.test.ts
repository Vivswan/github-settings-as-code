/**
 * schemaNode() names a union a knob only when knobbed(), nestedKnobbed(), or layeredList() minted its forms: the
 * engine routes a section's two forms by that reading, so a list-beside-wrapper union built by hand stays a plain
 * union, while a clone of a minted union (its options by reference) is still the knob.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { knobbed } from "../../src/sections/shared/schema-helpers.js";
import { schemaNode } from "../../src/sections/shared/schema-node.js";

const entry = z.object({ name: z.string() }).meta({ id: "SchemaNodeTestEntry" });

const knobOf = (schema: z.ZodType) => {
  const node = schemaNode(schema);
  return node.kind === "union" ? node.knob : null;
};

describe("schemaNode() reads a knob from the minting helper, not from the union's shape", () => {
  test("a hand-built list beside a strict wrapper with entries is a plain union", () => {
    const lookalike = z.union([
      z.array(entry),
      z.strictObject({
        _undeclared: z.enum(["keep", "delete"]).optional(),
        entries: z.array(entry),
      }),
    ]);
    expect(knobOf(lookalike)).toBeNull();
    expect(knobOf(knobbed(entry).meta({ description: "x" }))).not.toBeNull();
  });
});
