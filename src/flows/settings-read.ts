/**
 * The one place YAML settings documents are read and parsed. The read failure
 * carries the role the caller names the file by, because the right fix
 * differs per source (defaults file, layer, single settings file); a remote
 * file's text is parsed on its own through parseSettingsDoc. The parsed
 * document comes back UNKNOWN on purpose: nothing has validated it yet, so
 * only validateSettingsDoc (which returns the branded ValidatedSettings) can
 * turn it into something the engine accepts.
 */

import { readFileSync } from "node:fs";
import { err, ok, type Result } from "neverthrow";
import { parse as parseYaml } from "yaml";
import type { ProblemOf, SettingsFileRole } from "../problem.js";

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
export function parseSettingsDoc(raw: string): Result<unknown, ProblemOf<"yaml-invalid">> {
  try {
    return ok(parseYaml(raw, { logLevel: "error" }) ?? {});
  } catch (error) {
    return err({ code: "yaml-invalid", reason: String(error) });
  }
}

/** Read and parse one settings file; the problem covers both steps under the file's role. */
export function readSettingsFile(
  path: string,
  role: SettingsFileRole,
): Result<unknown, ProblemOf<"settings-file-unreadable">> {
  const unreadable = (reason: string): ProblemOf<"settings-file-unreadable"> => ({
    code: "settings-file-unreadable",
    role,
    path,
    reason,
  });
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return err(unreadable(String(error)));
  }
  return parseSettingsDoc(raw).mapErr((parse) => unreadable(parse.reason));
}
