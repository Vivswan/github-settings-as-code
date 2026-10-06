/**
 * Every SettingsFile property is composed from an export of its own section's slice module
 * (src/sections/<key>/schema.ts). A lookalike expression written into a SECTION_SLICES row (the same type with a
 * refinement dropped) passes the type and leaves the published schema identical, so only this reference check tells
 * it from the export.
 */

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { SECTION_KEYS, SettingsFile } from "../src/schema.js";
import { schemaNode } from "../src/sections/shared/schema-node.js";

/**
 * The slices a property wraps: the schema under .optional(), or under a knob both branches' slice, the entry
 * (knobbed() builds each list around it) or the list (layeredList() takes it whole on both sides).
 */
function slicesOf(key: string, property: z.ZodType): unknown[] {
  const node = schemaNode(property);
  expect(node.kind === "wrapper" && node.wrap === "optional", `${key}: not .optional()`).toBe(true);
  if (node.kind !== "wrapper") {
    return [property];
  }
  const inner = schemaNode(node.inner);
  if (inner.kind !== "union" || inner.knob === null) {
    return [node.inner];
  }
  const { kind, list, wrapper } = inner.knob;
  const entries = wrapper.shape.entries as z.ZodType;
  if (kind === "layered") {
    return [list, entries];
  }
  const entriesNode = schemaNode(entries);
  return [list.element, entriesNode.kind === "array" ? entriesNode.element : entries];
}

describe("each SettingsFile property wraps an export of its section's own slice module", () => {
  for (const key of SECTION_KEYS) {
    test(key, async () => {
      const exported = new Set<unknown>(
        Object.values(await import(`../src/sections/${key}/schema.js`)),
      );
      for (const slice of slicesOf(key, SettingsFile.shape[key])) {
        expect(
          exported.has(slice),
          `${key}: the property is not composed from an export of src/sections/${key}/schema.ts`,
        ).toBe(true);
      }
    });
  }
});
