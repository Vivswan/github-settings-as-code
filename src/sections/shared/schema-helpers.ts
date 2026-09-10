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
 * The merge-time directive on a top-level knobbed wrapper or at the document
 * root; consumed by engine/layers.ts. Described once in shared.docs.yml
 * (`UndeclaredPolicyList<*>._layering`) and src/schema.docs.yml.
 */
export const LayeringSchema = z.enum(["merge", "replace"]);

/** The wrapper's policy key before v3 renamed it; still the likeliest stray key on a wrapper. */
const RENAMED_POLICY_KEY = "undeclared";

/** The wrapper's error map: a v2 file fails with the rename in hand, not a bare unknown-key issue. */
function wrapperKeyError(issue: z.core.$ZodRawIssue): string | undefined {
  if (issue.code !== "unrecognized_keys" || !issue.keys.includes(RENAMED_POLICY_KEY)) {
    return undefined;
  }
  const keys = issue.keys.map((key) => JSON.stringify(key)).join(", ");
  return `Unrecognized key${issue.keys.length === 1 ? "" : "s"}: ${keys}; the wrapper's policy key "undeclared" was renamed to "_undeclared" in v3 (a directive, like _layering) - write _undeclared: keep or _undeclared: delete`;
}

/**
 * The knobbed form of a list value: the plain entry array, or the strict
 * {_undeclared, entries} wrapper (published under the definition name
 * "UndeclaredPolicyList<Entry>", matching the UndeclaredPolicyList type;
 * each key's meaning is its `UndeclaredPolicyList<*>.<key>` description in
 * shared.docs.yml, which the generator attaches). loosen() recognizes this union and rewraps it with the routed check that
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
function knobbedList<T extends z.ZodType, S extends z.core.$ZodShape>(
  entry: T,
  shape: (knobs: {
    _undeclared: z.ZodOptional<typeof UndeclaredPolicySchema>;
    entries: z.ZodArray<T>;
  }) => S,
) {
  const entryName = z.globalRegistry.get(entry)?.id;
  if (entryName === undefined) {
    throw new Error(
      "knobbed(): the entry schema carries no .meta({id}) name to derive the wrapper's definition name from; give the entry config a .meta({id})",
    );
  }
  const wrapper = z
    .strictObject(
      shape({ _undeclared: UndeclaredPolicySchema.optional(), entries: z.array(entry) }),
      { error: wrapperKeyError },
    )
    .meta({ id: `UndeclaredPolicyList<${entryName}>` });
  return z.union([z.array(entry), wrapper]);
}

/**
 * A TOP-LEVEL section's knobbed value, whose wrapper also takes the
 * `_layering` directive: the layered merge combines sections, so only a
 * section-level wrapper has layers below it to address.
 */
export function knobbed<T extends z.ZodType>(entry: T) {
  return knobbedList(entry, (knobs) => ({ ...knobs, _layering: LayeringSchema.optional() }));
}

/**
 * A knobbed list NESTED inside a section entry (environments[].variables),
 * whose wrapper rejects `_layering`: a nested list is replaced wholesale by
 * a higher layer, so the directive would be accepted and never act.
 */
export function nestedKnobbed<T extends z.ZodType>(entry: T) {
  return knobbedList(entry, (knobs) => knobs);
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
