/**
 * Leaf schema helpers shared by the root src/schema.ts and the per-section
 * schema modules under src/sections/<key>/schema.ts. This module imports
 * ONLY zod: a section schema importing root schema.ts back would be a cycle
 * whose top-level const evaluation TDZ-crashes at import time, so everything
 * both sides need lives here. The smoke selector
 * (.github/scripts/changed-sections.ts) derives this file's section fan-out
 * from the import graph.
 */

import { z } from "zod";

const UndeclaredPolicySchema = z.enum(["keep", "delete"]).meta({ id: "UndeclaredPolicy" });

/**
 * The merge-time directive, on a top-level knobbed wrapper or at the document
 * root: how the section (or every keyed section of the document) combines
 * with the layers BELOW it in a layered merge (engine/layers.ts) - "merge"
 * unions the entries by key, "replace" lets this layer's list win. It has no
 * effect on a single document and never reaches the merged result.
 */
export const LayeringSchema = z.enum(["merge", "replace"]);

/**
 * The knobbed form of a list value: the plain entry array, or the strict
 * {undeclared, entries} wrapper (published under the definition name
 * "UndeclaredPolicyList<Entry>", matching the UndeclaredPolicyList type).
 * loosen() recognizes this union and rewraps it with the routed check that
 * keeps precise per-entry issue paths. The wrapper's definition name derives
 * from the entry schema's own .meta({id}), so the document composition and a
 * section's runtime derivation can never label the same entry differently -
 * an entry without an id (or a clone that shed it) throws at MODULE LOAD,
 * not typecheck. Each call mints a fresh wrapper registered
 * under the same id; that is fine for z.toJSONSchema(SettingsFile) (it
 * resolves metadata by schema identity), but a generator iterating
 * z.globalRegistry's id map would see only the last-registered wrapper -
 * keep the published schema on the single-schema path.
 */
function knobbedList<T extends z.ZodType, W extends z.ZodObject>(
  entry: T,
  wrap: (knobs: {
    undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<T>;
  }) => W,
) {
  const entryName = z.globalRegistry.get(entry)?.id;
  if (entryName === undefined) {
    throw new Error(
      "knobbed(): the entry schema carries no .meta({id}) name to derive the wrapper's definition name from; give the entry config a .meta({id})",
    );
  }
  const wrapper = wrap({
    undeclared: UndeclaredPolicySchema.optional(),
    entries: z.array(entry),
  }).meta({ id: `UndeclaredPolicyList<${entryName}>` });
  return z.union([z.array(entry), wrapper]);
}

/**
 * A TOP-LEVEL section's knobbed value, whose wrapper also takes the
 * `_layering` directive: the layered merge combines sections, so only a
 * section-level wrapper has layers below it to address.
 */
export function knobbed<T extends z.ZodType>(entry: T) {
  return knobbedList(entry, (knobs) =>
    z.strictObject({ ...knobs, _layering: LayeringSchema.optional() }),
  );
}

/**
 * A knobbed list NESTED inside a section entry (environments[].variables),
 * whose wrapper rejects `_layering`: a nested list is replaced wholesale by
 * a higher layer, so the directive would be accepted and never act.
 */
export function nestedKnobbed<T extends z.ZodType>(entry: T) {
  return knobbedList(entry, (knobs) => z.strictObject(knobs));
}

/** A repository-scope sealed secret entry (name + `$NAME` reference value). */
export function sealedSecretConfig(id: string) {
  return z
    .object({
      name: z.string(),
      value: z.string(),
    })
    .meta({ id });
}
