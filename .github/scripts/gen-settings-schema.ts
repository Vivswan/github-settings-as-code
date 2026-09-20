/**
 * Emits lib/settings.schema.json from the zod single source in src/schema.ts (build:schema). z.toJSONSchema does the
 * heavy lifting and the docs files supply the descriptions (lib/schema-descriptions.ts); this script adds the
 * publication posture:
 *
 *   plain (strip) objects  -> OPENED: the additionalProperties: false zod emits is deleted, since GitHub-bound bodies
 *                             must accept future fields; only strictObject declarations stay closed, like the runtime
 *   url strings            -> UNFORMATTED: the format: "uri" z.url() emits is deleted, since ajv judges it by RFC 3986
 *                             and refuses hosts, paths, and spaces that the runtime's new URL() rule accepts
 *   date strings           -> UNFORMATTED: the format: "date" / "date-time" z.iso emits is deleted too, since ajv-formats
 *                             rounds long fractional seconds into an invalid :60; zod's pattern beside it stays and is the grammar
 *   defaulted keys         -> OPTIONAL: io: "input" describes the file, not the parsed output, so a key the slice
 *                             fills at parse (a ruleset's target) stays out of required and keeps its default keyword
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
  format?: string;
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
    // z.url() parses with new URL(), which takes a non-ASCII host or path and a space; ajv's format: "uri" refuses all
    // three, so the keyword goes and the runtime alone judges the URL (the string stays typed and described).
    if (def.type === "string" && def.format === "url") {
      delete json.format;
    }
    // z.iso.date()/datetime() emit a pattern that is the runtime's grammar plus a format keyword; ajv-formats parses a
    // long fractional second as a number and rounds it into an invalid :60, refusing what the runtime accepts.
    if (def.type === "string" && (def.format === "date" || def.format === "datetime")) {
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
