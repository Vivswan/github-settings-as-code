/**
 * GraphQL mutations address their target through node ids alone (no owner/repo in the variables), so the pipeline
 * recovers the target slug FROM the id to keep per-slug permission masks and state routing exact. A mutation carrying
 * no id the codec minted is a loud violation, never a guess.
 *   "MOCKNODE:<family>:<slug>:<key>" -> base64: looks like GitHub's opaque ids, decodable by the mock alone
 *
 * A leaf below state.ts and support.ts, so either seam and any per-section fragment can mint or decode.
 */

const NODE_ID_PREFIX = "MOCKNODE";

const NODE_FAMILIES = ["repo", "environment", "rule", "user", "team", "app"] as const;
export type NodeFamily = (typeof NODE_FAMILIES)[number];

/** `key` is the resource's natural key within the family; empty for the repo itself, whose slug says everything. */
export function mintNodeId(family: NodeFamily, slug: string, key: string): string {
  return Buffer.from(`${NODE_ID_PREFIX}:${family}:${slug}:${key}`, "utf8").toString("base64");
}

/**
 * Null for anything this mock did not mint (a fixture's GitHub-realistic id, an arbitrary string, an
 * unknown family). The slug never contains ":" (the owner/name charset), so the first two separators are
 * unambiguous; the key keeps any ":" it carries.
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
 * GitHub Apps are not repo-scoped, so their ids carry this sentinel and the pipeline's mutation-target
 * resolution skips the "app" family (GLOBAL_NODE_FAMILIES in routes.ts).
 */
const GLOBAL_NODE_SLUG = "-";

export function mintAppNodeId(appSlug: string): string {
  return mintNodeId("app", GLOBAL_NODE_SLUG, appSlug);
}
