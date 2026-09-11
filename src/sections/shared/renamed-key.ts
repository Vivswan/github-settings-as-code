/**
 * The zod error map for a strict object whose key was renamed: a document still using the old key
 * fails with the rename in hand, not a bare unknown-key issue. Imports ONLY zod, like its
 * schema-helpers.ts sibling, so both the settings slices and the docs shapes can use it.
 */

import type { z } from "zod";

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
    return `Unrecognized key${issue.keys.length === 1 ? "" : "s"}: ${keys}; the ${what} key ${JSON.stringify(oldKey)} was renamed to ${JSON.stringify(newKey)} ${tail}`;
  };
}
