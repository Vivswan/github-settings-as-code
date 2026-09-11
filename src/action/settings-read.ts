/**
 * The one place YAML settings documents are read and parsed. Callers
 * compose their own advice around the returned raw error string, because
 * the right fix differs per source (defaults file, central file, single
 * settings file, remote file). The parsed document comes back UNKNOWN on
 * purpose: nothing has validated it yet, so only validateSettingsDoc (which
 * returns the branded ValidatedSettings) can turn it into something the
 * engine accepts.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

/** Parse one YAML settings document; empty/null documents become {}. */
export function parseSettingsDoc(raw: string): { doc: unknown } | { error: string } {
  try {
    return { doc: parseYaml(raw) ?? {} };
  } catch (error) {
    return { error: String(error) };
  }
}

/** Read and parse one settings file; the error covers both steps. */
export function readSettingsFile(path: string): { doc: unknown } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { error: String(error) };
  }
  return parseSettingsDoc(raw);
}
