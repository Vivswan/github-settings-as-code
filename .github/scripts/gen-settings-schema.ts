/**
 * Emits lib/settings.schema.json from the zod single source in src/schema.ts
 * (run by build:schema). z.toJSONSchema does the heavy lifting - .describe()
 * strings become descriptions, .meta({id}) names the definitions, strict
 * objects close with additionalProperties: false - and this script supplies
 * the publication posture around it:
 * - plain (strip) objects are OPENED by deleting the additionalProperties:
 *   false zod emits for them (the passthrough-first forward-compatibility
 *   tenet: GitHub-bound bodies must accept future fields; only strictObject
 *   declarations stay closed, exactly like the runtime);
 * - the root document sits in definitions.SettingsFile behind a top-level
 *   $ref (zod >= 4.5 emits an id'd root that way natively; the script
 *   verifies the layout loudly instead of hoisting by hand);
 * - the stable $id is stamped (see SCHEMA_ID below);
 * - definitions are sorted so the committed file diffs deterministically.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SettingsFile } from "../../src/schema.js";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The schema's stable identity: the raw copy of this file at the moving
 * v<MAJOR> tag. One raw-URL template serves every ref - the canonical
 * moving major, exact release tags, the legacy main copy - matching how the
 * action itself is pinned. The major comes from
 * .release-please-manifest.json, the version single source release-please
 * bumps on every release (package.json deliberately carries no version), so
 * a major release moves the $id automatically on the next schema build.
 */
const manifestVersion = (
  JSON.parse(readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8")) as Record<
    string,
    string
  >
)["."];
const major = manifestVersion?.match(/^(\d+)\./)?.[1];
if (major === undefined) {
  throw new Error(
    `gen-settings-schema: cannot derive the major version from .release-please-manifest.json ("." is ${JSON.stringify(manifestVersion)})`,
  );
}
const SCHEMA_ID = `https://raw.githubusercontent.com/Vivswan/github-settings-as-code/v${major}/lib/settings.schema.json`;

interface ZodDefView {
  type?: string;
  catchall?: unknown;
}

const generated = z.toJSONSchema(SettingsFile, {
  target: "draft-7",
  override(ctx) {
    const def = (ctx.zodSchema as unknown as { _zod: { def: ZodDefView } })._zod.def;
    const json = ctx.jsonSchema as Record<string, unknown>;
    // Open every plain (strip) object: zod emits additionalProperties: false
    // for them, but the runtime passes unknown keys through to GitHub, and
    // the published schema must not reject what the runtime accepts. Strict
    // objects carry a catchall (z.never) and keep their false.
    if (def.type === "object" && def.catchall === undefined) {
      delete json.additionalProperties;
    }
    // z.record's propertyNames: {type: "string"} is a no-op in JSON (keys
    // are always strings); dropped for a quieter document.
    if (def.type === "record" && JSON.stringify(json.propertyNames) === '{"type":"string"}') {
      delete json.propertyNames;
    }
    // z.int()'s implicit safe-integer bounds are a JS implementation detail,
    // not part of the documented file format; a deliberate .min()/.max()
    // carries different values and stays.
    if (json.type === "integer") {
      if (json.minimum === Number.MIN_SAFE_INTEGER) {
        delete json.minimum;
      }
      if (json.maximum === Number.MAX_SAFE_INTEGER) {
        delete json.maximum;
      }
    }
  },
}) as Record<string, unknown> & { definitions?: Record<string, unknown> };

// The wrapper definition names carry "<" and ">"; percent-encode them inside
// $ref pointers so the refs stay valid URI references for strict consumers
// (ajv resolves both spellings; the previous generator emitted the encoded
// form).
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

// zod >= 4.5 emits an id'd root as a top-level $ref plus its own
// definitions.SettingsFile - exactly the published layout. Two loud guards
// on that assumption: a zod that inlines the root again (the < 4.5
// behavior) would need the old manual hoist back, and a root carrying more
// than the $ref would silently lose those keys in the write below.
const ROOT_REF = "#/definitions/SettingsFile";
const { $schema, definitions, ...rootBody } = generated;
if (rootBody.$ref !== ROOT_REF || Object.keys(rootBody).length !== 1) {
  throw new Error(
    `gen-settings-schema: expected zod to emit the root as exactly {$ref: "${ROOT_REF}"} (zod >= 4.5), got ${JSON.stringify(rootBody)} - update the root handling`,
  );
}
if (definitions?.SettingsFile === undefined) {
  throw new Error(
    "gen-settings-schema: zod emitted a root $ref without a SettingsFile definition - update the root handling",
  );
}
const sortedDefinitions = Object.fromEntries(
  Object.entries(definitions).sort(([a], [b]) => (a < b ? -1 : 1)),
);

const schemaPath = join(ROOT, "lib", "settings.schema.json");
writeFileSync(
  schemaPath,
  JSON.stringify(
    {
      $id: SCHEMA_ID,
      $ref: ROOT_REF,
      $schema,
      definitions: sortedDefinitions,
    },
    null,
    2,
  ),
);
console.log(
  `gen-settings-schema: wrote ${schemaPath} (${Object.keys(sortedDefinitions).length} definitions)`,
);
