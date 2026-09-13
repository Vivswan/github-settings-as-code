/**
 * Imports ONLY zod and renamed-key.ts: a section schema importing src/schema.ts back would be a cycle
 * whose top-level consts TDZ-crash at import time, so everything both sides need lives here.
 * The smoke selector (.github/scripts/changed-sections.ts) derives this file's section fan-out from the import graph.
 */

import { z } from "zod";
import { renamedKeyError } from "./renamed-key.js";

const UndeclaredPolicySchema = z.enum(["keep", "delete"]).meta({ id: "UndeclaredPolicy" });

/**
 * engine/layers.ts declares the same value set in its own Layering type and acts on the parsed value, so a
 * new value lands in both. Described in shared.docs.yml and src/schema.docs.yml.
 */
export const LayeringSchema = z.enum(["merge", "replace"]);

const renamedPolicyKeyError = renamedKeyError(
  "wrapper's policy",
  "undeclared",
  "_undeclared",
  "in v3 (a directive, like _layering) - write _undeclared: keep or _undeclared: delete",
);

/**
 * The wrapper's unrecognized keys: the pre-v3 policy spelling names its rename, and any other underscore key names
 * the two directives, since a wrapper takes no private notes either (the document level says the same in
 * src/problem.ts). A misspelled entry field is the strict object's own line.
 */
function wrapperKeyError(issue: z.core.$ZodRawIssue): string | undefined {
  const renamed = renamedPolicyKeyError(issue);
  if (renamed !== undefined) {
    return renamed;
  }
  if (issue.code !== "unrecognized_keys" || !issue.keys.some((key) => key.startsWith("_"))) {
    return undefined;
  }
  const keys = issue.keys.map((key) => JSON.stringify(key)).join(", ");
  return (
    `Unrecognized key${issue.keys.length === 1 ? "" : "s"}: ${keys}; the wrapper's directives are ` +
    '"_undeclared" and, on a top-level section, "_layering", and nothing else - there are no ' +
    "private-note keys. Remove the key, or keep the note as a YAML comment"
  );
}

/**
 * loosen() (../contract/module.ts) recognizes this union and rewraps it with the routed check that keeps
 * per-entry issue paths. The wrapper's definition name derives from the entry's own .meta({id}), so the
 * document composition and a section's runtime derivation can never label one entry differently.
 *
 *   entry without an id                        -> throws at MODULE LOAD, not typecheck
 *   z.toJSONSchema(SettingsFile)               -> fine: it resolves metadata by schema identity
 *   a generator over z.globalRegistry's ids    -> sees only the last-registered wrapper (each call mints a fresh one under the same id)
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
 * Only a TOP-LEVEL wrapper takes `_layering`: the layered merge combines sections, so only a
 * section-level wrapper has layers below it to address.
 */
export function knobbed<T extends z.ZodType>(entry: T) {
  return knobbedList(entry, (knobs) => ({ ...knobs, _layering: LayeringSchema.optional() }));
}

/**
 * A nested list (environments[].variables) is replaced wholesale by a higher layer, so `_layering`
 * would be accepted and never act; the wrapper rejects it.
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
