/**
 * Emits lib/settings.schema.json from the zod single source in src/schema.ts (build:schema). z.toJSONSchema does the
 * heavy lifting and the docs files supply the descriptions (lib/schema-descriptions.ts); this script adds the
 * publication posture:
 *
 *   plain (strip) objects  -> OPENED: the additionalProperties: false zod emits is deleted, since GitHub-bound bodies
 *                             must accept future fields; only strictObject declarations stay closed, like the runtime
 *   root layout            -> zod's own, passed through verbatim
 *   $id                    -> stamped (SCHEMA_ID); definitions sorted so the committed file diffs deterministically
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SettingsFile } from "../../src/schema.js";
import { SCHEMA_DESCRIPTIONS } from "../../src/sections/docs-registry.js";
import { attachDescriptions, type JsonSchemaNode } from "./lib/schema-descriptions.js";

const ROOT = join(import.meta.dir, "..", "..");

/** The raw copy at HEAD, naming no release: editors pin a version through the same URL at a release ref (see the
 * README), and a versioned $id would need the schema regenerated on every major bump's release PR. */
const SCHEMA_ID =
  "https://raw.githubusercontent.com/Vivswan/github-settings-as-code/HEAD/lib/settings.schema.json";

interface ZodDefView {
  type?: string;
  catchall?: unknown;
}

const generated = z.toJSONSchema(SettingsFile, {
  target: "draft-7",
  override(ctx) {
    const def = (ctx.zodSchema as unknown as { _zod: { def: ZodDefView } })._zod.def;
    const json = ctx.jsonSchema as Record<string, unknown>;
    // The runtime passes unknown keys of a plain object through to GitHub, and the published schema must not reject
    // what the runtime accepts. Strict objects carry a catchall (z.never) and keep their false.
    if (def.type === "object" && def.catchall === undefined) {
      delete json.additionalProperties;
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

// No layout assumption is guarded here: a future zod's shape change surfaces as schema-check drift, and a broken
// emission fails the published-schema tests (ajv compile plus fixture round-trips).
const { definitions, ...rest } = generated;
const sortedDefinitions = Object.fromEntries(
  Object.entries(definitions ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
);

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
