/**
 * The one place settings YAML is parsed. The read problem carries the role the caller names the file by, because the
 * right advice differs per source, and the document comes back `unknown`: only validateSettingsDoc mints ValidatedSettings.
 */

import { readFileSync } from "node:fs";
import { err, ok, type Result } from "neverthrow";
import { type Document, isAlias, type Node, parseDocument, visit } from "yaml";
import type { ProblemOf, SettingsFileRole } from "../problem.js";

/**
 * The parser builds an alias into the node its own anchor opens as a cyclic object (YAML permits it), which no
 * settings document can carry and no later check could name by anchor. An alias names the latest anchor of that
 * name before it, tracked here in one pass; `Alias.resolve` applies the same rule by walking the whole document per
 * call, quadratic on a long alias list.
 */
function openAnchorAliased(doc: Document): string | null {
  const anchored = new Map<string, Node>();
  const cyclic: string[] = [];
  visit(doc, {
    Node(_key, node, path) {
      if (!isAlias(node)) {
        if (node.anchor !== undefined) {
          anchored.set(node.anchor, node);
        }
        return undefined;
      }
      const source = anchored.get(node.source);
      if (source !== undefined && path.includes(source)) {
        cyclic.push(node.source);
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return cyclic[0] ?? null;
}

/**
 * `logLevel: "error"` is load-bearing: at its default, building the object reports a collection used as a mapping
 * key through process.emitWarning, quoting its values straight to stderr, which nothing here redacts. The document's
 * own warnings (an unresolved tag, an anchor ending in ":") are never forwarded. Empty and null documents become {}.
 *
 * `merge: true` resolves `<<` merge keys as the Probot app's js-yaml did; off, the key survives as literal data.
 *
 * The catch is the parser's contract: an unresolved alias or an alias bomb surfaces while the object is built.
 */
export function parseSettingsDoc(raw: string): Result<unknown, ProblemOf<"yaml-invalid">> {
  const invalid = (reason: string): Result<never, ProblemOf<"yaml-invalid">> =>
    err({ code: "yaml-invalid", reason });
  const doc = parseDocument(raw, { logLevel: "error", merge: true });
  const [syntaxError] = doc.errors;
  if (syntaxError !== undefined) {
    return invalid(String(syntaxError));
  }
  const anchor = openAnchorAliased(doc);
  if (anchor !== null) {
    return invalid(
      `alias *${anchor} refers back into the node its anchor &${anchor} opens (a YAML alias cycle), ` +
        "which no settings document can carry. An alias may only reference a completed node: write " +
        "the value out again, or move the anchor to a sibling",
    );
  }
  try {
    return ok(doc.toJS() ?? {});
  } catch (error) {
    return invalid(String(error));
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
