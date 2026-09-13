/**
 * Parse what the API returned ONCE, where it enters a section: the "parse, don't cast" sibling of the
 * declared-value boundary in engine/validate.ts. A body off the documented shape fails here naming the
 * endpoint and the defects, instead of surfacing later as a silent misread.
 */

import type { z } from "zod";
import { type EndpointDecl, endpointMethod, endpointPath } from "./endpoints.js";
import type { SectionMeta } from "./module.js";
import { collidingPairs } from "./requests.js";

/**
 * Live items indexed by the identity the section manages them under. GitHub may hold two under one
 * (repeated deploy-key titles, repeated hook urls, two names one fold apart), which a single-slot map
 * would silently collapse into "the last one listed"; plan() and snapshot() both refuse that here, so
 * every section fails the same way and names the pairs.
 */
export function liveByIdentity<T, Key extends string>(
  section: SectionMeta,
  noun: string,
  items: readonly T[],
  keyOf: (item: T) => Key,
  describe: (item: T) => string,
): Map<Key, T> {
  const collisions = collidingPairs(items, keyOf, describe);
  if (collisions.length > 0) {
    throw new Error(
      `${section.key}: GitHub holds ${noun}s that resolve to one identity: ${collisions.join("; ")}. This section manages one ${noun} per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again`,
    );
  }
  return new Map(items.map((item) => [keyOf(item), item]));
}

/**
 * Schemas stay loose objects, so passthrough fields survive for subsetDiff/phantomKeys. `describe` names
 * the concrete resource (an environment, a page) the path template alone cannot spell.
 */
export function parseLive<T>(
  section: SectionMeta,
  endpoint: EndpointDecl,
  schema: z.ZodType<T>,
  data: unknown,
  describe?: string,
): T {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return parsed.data;
  }
  const issues = parsed.error.issues;
  const shown = issues.slice(0, 3).map((issue) => {
    const path = issue.path
      .map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`))
      .join("");
    return `${path.replace(/^\./, "") || "(body)"}: ${issue.message}`;
  });
  const more = issues.length > 3 ? `; and ${issues.length - 3} more issue(s)` : "";
  const where = describe === undefined ? "" : ` (${describe})`;
  throw new Error(
    `${section.key}: ${endpointMethod(endpoint.route)} ${endpointPath(endpoint.route)}${where} returned a body outside the documented shape - ${shown.join("; ")}${more}. Check the "api-version" input against the GitHub REST docs for this endpoint`,
  );
}
