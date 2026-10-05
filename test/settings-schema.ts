import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT } from "./root.js";

/** The built, gitignored schema; `bun run test` and `bun run fuzz` run `bun run build:schema` before loading it. */
export const SETTINGS_SCHEMA_PATH = join(ROOT, "lib", "settings.schema.json");

export interface SettingsSchemaFile {
  $id: string;
  definitions: Record<string, Record<string, unknown>>;
  [keyword: string]: unknown;
}

/**
 * The one line a test fails with when the built schema is absent, raised before any step that would misreport the
 * absence as a defect of its own (tsc's TS2307 against a docs page, ajv's compile error): the generator only writes
 * the file into the tree, so a test cannot build it elsewhere and names the build step instead.
 */
export function schemaNotBuilt(path: string): Error {
  return new Error(`${relative(ROOT, path)} is not built; run \`bun run build:schema\``);
}

/** Read at run time rather than imported: `tsc` resolves a JSON import, so an import would fail every typecheck on
 * a checkout that has not built the file. */
export function readSettingsSchema(): SettingsSchemaFile {
  if (!existsSync(SETTINGS_SCHEMA_PATH)) {
    throw schemaNotBuilt(SETTINGS_SCHEMA_PATH);
  }
  return JSON.parse(readFileSync(SETTINGS_SCHEMA_PATH, "utf8")) as SettingsSchemaFile;
}
