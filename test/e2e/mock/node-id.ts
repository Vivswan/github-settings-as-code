/**
 * The mock's node-id codec. Every node_id the mock serves is minted here,
 * self-describing: GraphQL mutations address their target through node ids
 * alone (no owner/repo in the variables), so the pipeline must recover the
 * target slug FROM the id to keep per-slug permission masks and state routing
 * exact. A base64 wrapper over a "MOCKNODE:<family>:<slug>:<key>" spine gives
 * ids that look like GitHub's (opaque base64) while staying decodable by the
 * mock alone; an id the codec cannot decode inside a mutation is a loud
 * violation, never a guess.
 *
 * A leaf module below state.ts and support.ts, so either seam (and any
 * per-section mock fragment) can mint or decode without pulling in the other.
 */

const NODE_ID_PREFIX = "MOCKNODE";

/**
 * The closed vocabulary of node-id families: every mint site and every decode
 * consumer speaks these literals, so a typo at either end is a compile
 * error instead of a runtime NOT_FOUND hunt.
 */
const NODE_FAMILIES = ["repo", "environment", "rule", "user", "team", "app"] as const;
export type NodeFamily = (typeof NODE_FAMILIES)[number];

/**
 * Mint the node id for one resource: `family` names the resource kind
 * ("repo", "environment", ...), `slug` the owning repository, and `key` the
 * resource's natural key within the family (empty for the repo itself, whose
 * slug says everything).
 */
export function mintNodeId(family: NodeFamily, slug: string, key: string): string {
  return Buffer.from(`${NODE_ID_PREFIX}:${family}:${slug}:${key}`, "utf8").toString("base64");
}

/**
 * Decode a minted node id back to its parts, or null for anything this mock
 * did not mint (a fixture's GitHub-realistic id, an arbitrary string, a spine
 * whose family is outside the closed vocabulary). The slug never contains ":"
 * (the owner/name charset), so the first two separators are unambiguous; the
 * key keeps any ":" it carries.
 */
export function decodeNodeId(
  nodeId: string,
): { family: NodeFamily; slug: string; key: string } | null {
  const decoded = Buffer.from(nodeId, "base64").toString("utf8");
  const parts = decoded.split(":");
  const family = parts[1];
  const slug = parts[2];
  if (
    parts[0] !== NODE_ID_PREFIX ||
    parts.length < 4 ||
    family === undefined ||
    !(NODE_FAMILIES as readonly string[]).includes(family) ||
    !slug
  ) {
    return null;
  }
  return {
    family: family as NodeFamily,
    slug,
    key: parts.slice(3).join(":"),
  };
}

/**
 * The repo-slug half of a GLOBAL resource's node id: GitHub Apps are not
 * repo-scoped, so their minted ids carry this sentinel and the pipeline's
 * mutation-target resolution skips the "app" family (see GLOBAL_NODE_FAMILIES
 * in routes.ts).
 */
const GLOBAL_NODE_SLUG = "-";

/** Mint the global node id of a GitHub App, keyed by its slug. */
export function mintAppNodeId(appSlug: string): string {
  return mintNodeId("app", GLOBAL_NODE_SLUG, appSlug);
}
