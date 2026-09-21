/**
 * The zod error map for a strict object whose key was renamed: a document still using the old key
 * fails with the rename in hand, not a bare unknown-key issue. Imports only zod and the
 * text leaf, like its schema-helpers.ts sibling, so the settings slices can use it.
 */

import type { z } from "zod";
import { agree } from "../../text.js";

/** For `z.strictObject(shape, { error })`; `what` and `tail` are the prose around the two keys. */
export function renamedKeyError(
  what: string,
  oldKey: string,
  newKey: string,
  tail: string,
): (issue: z.core.$ZodRawIssue) => string | undefined {
  return (issue) => {
    if (issue.code !== "unrecognized_keys" || !issue.keys.includes(oldKey)) {
      return undefined;
    }
    const keys = issue.keys.map((key) => JSON.stringify(key)).join(", ");
    return `${agree(issue.keys.length, "Unrecognized key", "Unrecognized keys")}: ${keys}; the ${what} key ${JSON.stringify(oldKey)} was renamed to ${JSON.stringify(newKey)} ${tail}`;
  };
}
