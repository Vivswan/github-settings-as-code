/**
 * Emits lib/settings.schema.json from the zod single source in src/schema.ts (build:schema). z.toJSONSchema does the
 * heavy lifting and the docs files supply the descriptions (lib/schema-descriptions.ts); this script adds the
 * publication posture:
 *
 *   plain (strip) objects  -> OPENED: the additionalProperties: false zod emits is deleted, since GitHub-bound bodies
 *                             must accept future fields; only strictObject declarations stay closed, like the runtime
 *   format keywords        -> DELETED: every format zod emits goes, whether ajv-formats judges it by a grammar the runtime
 *                             does not share ("uri" refuses non-ASCII hosts and spaces new URL() takes; "date-time" rounds
 *                             a long fractional second into an invalid :60) or JSON Schema does not define it at all
 *                             ("includes", from zod 4.6.0's folding of string checks); zod's pattern beside it stays and is the grammar
 *   defaulted keys         -> OPTIONAL: io: "input" describes the file, not the parsed output, so a key the slice
 *                             fills at parse (a ruleset's target) stays out of required and keeps its default keyword
 *   root layout            -> zod's own, passed through verbatim
 *   $id                    -> stamped (SCHEMA_ID); definitions sorted so the built file is deterministic
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SettingsFile } from "../../src/schema.js";
import { SCHEMA_DESCRIPTIONS } from "../../src/sections/docs-registry.js";
import { attachDescriptions, type JsonSchemaNode } from "./lib/schema-descriptions.js";
import { SCHEMA_ID } from "./lib/schema-id.js";

const ROOT = join(import.meta.dir, "..", "..");

interface ZodDefView {
  type?: string;
  catchall?: unknown;
}

const generated = z.toJSONSchema(SettingsFile, {
  target: "draft-7",
  io: "input",
  override(ctx) {
    const def = (ctx.zodSchema as unknown as { _zod: { def: ZodDefView } })._zod.def;
    const json = ctx.jsonSchema as Record<string, unknown>;
    // The runtime passes unknown keys of a plain object through to GitHub, and the published schema must not reject
    // what the runtime accepts. Strict objects carry a catchall (z.never) and keep their false.
    if (def.type === "object" && def.catchall === undefined) {
      delete json.additionalProperties;
    }
    // The published schema carries no format keyword, so this covers ajv-formats grammars the runtime does not share
    // ("uri", "date-time") and names JSON Schema never defined, such as the format: "includes" zod 4.6.0 (#6554) emits
    // for .includes() since it copies every string_format check's name; zod's pattern beside it stays as the grammar.
    if ("format" in json) {
      delete json.format;
    }
    // z.record's propertyNames: {type: "string"} is a no-op in JSON (keys are always strings).
    if (def.type === "record" && JSON.stringify(json.propertyNames) === '{"type":"string"}') {
      delete json.propertyNames;
    }
    // z.int()'s implicit safe-integer bounds are a JS implementation detail, not part of the documented file
    // format; a deliberate .min()/.max() carries different values and stays.
    if (json.type === "integer") {
      if (json.minimum === Number.MIN_SAFE_INTEGER) {
        delete json.minimum;
      }
      if (json.maximum === Number.MAX_SAFE_INTEGER) {
        delete json.maximum;
      }
    }
  },
}) as Record<string, unknown> & { definitions?: Record<string, JsonSchemaNode> };

attachDescriptions(generated.definitions ?? {}, SCHEMA_DESCRIPTIONS);

// The wrapper definition names carry "<" and ">"; percent-encoded inside $ref pointers, the refs stay valid URI
// references for strict consumers (ajv resolves both spellings).
function encodeRefs(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      encodeRefs(item);
    }
    return;
  }
  if (typeof node !== "object" || node === null) {
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    record.$ref = record.$ref.replaceAll("<", "%3C").replaceAll(">", "%3E");
  }
  for (const value of Object.values(record)) {
    encodeRefs(value);
  }
}
encodeRefs(generated);

// No layout assumption is guarded here: a future zod's shape change or a broken emission fails the
// published-schema tests (ajv compile plus fixture round-trips), which load the file this script writes.
const { definitions, ...rest } = generated;
const sortedDefinitions = Object.fromEntries(
  Object.entries(definitions ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
);

// A fresh checkout has no lib/: nothing under it is committed.
mkdirSync(join(ROOT, "lib"), { recursive: true });
const schemaPath = join(ROOT, "lib", "settings.schema.json");
writeFileSync(
  schemaPath,
  JSON.stringify(
    {
      // $id after the spread: the stamp must win over any $id zod emits.
      ...rest,
      $id: SCHEMA_ID,
      definitions: sortedDefinitions,
    },
    null,
    2,
  ),
);
console.log(
  `gen-settings-schema: wrote ${schemaPath} (${Object.keys(sortedDefinitions).length} definitions)`,
);
