/**
 * The one place settings YAML is parsed. The read problem carries the role the caller names the file by, because the
 * right advice differs per source, and the document comes back `unknown`: only validateSettingsDoc mints ValidatedSettings.
 */

import { readFileSync } from "node:fs";
import { err, ok, type Result } from "neverthrow";
import { parse as parseYaml } from "yaml";
import type { ProblemOf, SettingsFileRole } from "../problem.js";

/**
 * `logLevel: "error"` is load-bearing: at its default the parser reports a warning (an unresolved tag, an anchor ending
 * in ":") on a SUCCESSFUL parse through process.emitWarning, quoting the offending source line with its values straight
 * to stderr, which nothing here redacts. Empty and null documents become {}.
 *
 * "error"   -> warnings silent; a syntax error still throws into the error path
 * "silent"  -> would also swallow the syntax errors
 */
export function parseSettingsDoc(raw: string): Result<unknown, ProblemOf<"yaml-invalid">> {
  try {
    return ok(parseYaml(raw, { logLevel: "error" }) ?? {});
  } catch (error) {
    return err({ code: "yaml-invalid", reason: String(error) });
  }
}

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
