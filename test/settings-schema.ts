import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./root.js";

/** The built, gitignored schema; `bun run test` and `bun run fuzz` run `bun run build:schema` before loading it. */
export const SETTINGS_SCHEMA_PATH = join(ROOT, "lib", "settings.schema.json");

export interface SettingsSchemaFile {
  $id: string;
  definitions: Record<string, Record<string, unknown>>;
  [keyword: string]: unknown;
}

/** Read at run time rather than imported: `tsc` resolves a JSON import, so an import would fail every typecheck on
 * a checkout that has not built the file. */
export function readSettingsSchema(): SettingsSchemaFile {
  if (!existsSync(SETTINGS_SCHEMA_PATH)) {
    throw new Error("lib/settings.schema.json is not built; run `bun run build:schema`");
  }
  return JSON.parse(readFileSync(SETTINGS_SCHEMA_PATH, "utf8")) as SettingsSchemaFile;
}
