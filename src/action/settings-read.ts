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

/**
 * Parse one YAML settings document; empty/null documents become {}.
 *
 * At its default log level the parser reports a warning (an unresolved tag,
 * an unknown directive, an anchor ending in ":", a collection used as a key)
 * on a SUCCESSFUL parse through process.emitWarning, quoting the offending
 * source line, values included, straight to stderr: a channel no message of
 * ours words or redacts. "error" keeps every warning silent while a syntax
 * error still throws into the error path below; "silent" would also swallow
 * the errors and return a partial document.
 */
export function parseSettingsDoc(raw: string): { doc: unknown } | { error: string } {
  try {
    return { doc: parseYaml(raw, { logLevel: "error" }) ?? {} };
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
