/**
 * Parse what the API returned ONCE, where it enters a section: the "parse, don't cast" sibling of the
 * declared-value boundary in engine/validate.ts. A body off the documented shape fails here naming the
 * endpoint and the defects, instead of surfacing later as a silent misread.
 */

import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";
import { countNoun } from "../../text.js";
import { endpointMethod, endpointPath } from "./endpoints.js";
import type { SectionFailure } from "./errors.js";
import type { FailingOp, SectionMeta } from "./module.js";
import { collidingPairs } from "./requests.js";

/** The plural of a section noun for a message ("custom property" -> "custom properties", "protected branch" -> "protected branches"). */
export function plural(noun: string): string {
  if (/[^aeiou]y$/.test(noun)) {
    return `${noun.slice(0, -1)}ies`;
  }
  return /(s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`;
}

/**
 * The ONE rendering of a live item in a duplicate-identity message: the human key, then the server-side
 * addressing values that tell two apart (`v1 (milestone number 1)`; a value equal to the key adds nothing,
 * so a label's address IS its name). The brand is minted here alone, so every producer renders alike.
 */
declare const LIVE_IDENTITY: unique symbol;
export type LiveIdentity = string & { readonly [LIVE_IDENTITY]: true };

export function liveIdentity(
  name: string,
  address: Readonly<Record<string, string | number | undefined>> = {},
): LiveIdentity {
  const ids = Object.entries(address).filter(
    (entry): entry is [string, string | number] =>
      entry[1] !== undefined && String(entry[1]) !== name,
  );
  const rendered =
    ids.length === 0
      ? name
      : `${name} (${ids.map(([param, value]) => `${param.replace(/_/g, " ")} ${value}`).join(", ")})`;
  return rendered as LiveIdentity;
}

/**
 * Live items indexed by the identity the section manages them under. GitHub may hold two under one
 * (repeated deploy-key titles, repeated hook urls, two names one fold apart), which a single-slot map
 * would silently collapse into "the last one listed"; plan() and snapshot() both refuse that here, so
 * every section fails the same way and names the pairs through liveIdentity. Only the key is read,
 * so a helper holding a PlanContext passes `{ key: ctx.section }`.
 */
export function liveByIdentity<T, Key extends string>(
  section: Pick<SectionMeta, "key">,
  noun: string,
  items: readonly T[],
  keyOf: (item: T) => Key,
  describe: (item: T) => LiveIdentity,
): Result<Map<Key, T>, SectionFailure> {
  const collisions = collidingPairs(items, keyOf, describe);
  if (collisions.length > 0) {
    return err({
      kind: "live-duplicate",
      message: `${section.key}: GitHub holds ${plural(noun)} that resolve to one identity: ${collisions.join("; ")}. This section manages one ${noun} per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again`,
    });
  }
  return ok(new Map(items.map((item) => [keyOf(item), item])));
}

/**
 * Schemas stay loose objects, so passthrough fields survive for subsetDiff/phantomKeys. `describe` names
 * the concrete resource (an environment, a page) the path template alone cannot spell. The read port
 * (./plan.ts) parses every answer through it; a section reaches it directly only for a write's response.
 */
export function parseLive<T>(
  section: Pick<SectionMeta, "key">,
  op: FailingOp,
  schema: z.ZodType<T>,
  data: unknown,
  describe?: string,
): Result<T, SectionFailure> {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return ok(parsed.data);
  }
  const issues = parsed.error.issues;
  const shown = issues.slice(0, 3).map((issue) => {
    const path = issue.path
      .map((part) => (typeof part === "number" ? `[${part}]` : `.${String(part)}`))
      .join("");
    return `${path.replace(/^\./, "") || "(body)"}: ${issue.message}`;
  });
  const more =
    issues.length > 3 ? `; and ${countNoun(issues.length - 3, "more issue", "more issues")}` : "";
  const where = describe === undefined ? "" : ` (${describe})`;
  const request =
    "route" in op ? `${endpointMethod(op.route)} ${endpointPath(op.route)}` : `GRAPHQL ${op.name}`;
  const reference =
    "route" in op
      ? "GitHub REST docs for this endpoint"
      : "GitHub GraphQL reference for this operation";
  return err({
    kind: "malformed",
    message: `${section.key}: ${request}${where} returned a body outside the documented shape - ${shown.join("; ")}${more}. Check the "api-version" input against the ${reference}`,
  });
}
