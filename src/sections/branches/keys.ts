/**
 * Vocabulary GitHub's protection GET carries that the PUT has no word for. index.ts drops it from
 * the live body (flattenProtection) and schema.ts refuses it in a declaration: a copied GET response
 * would otherwise never read back equal and drift forever, or 422 where the PUT expects a boolean.
 */

const GET_ONLY_KEYS: ReadonlySet<string> = new Set(["name", "enabled", "enforcement_level"]);

export const isUrlKey = (key: string): boolean => key === "url" || key.endsWith("_url");

export const isGetOnlyKey = (key: string): boolean => GET_ONLY_KEYS.has(key) || isUrlKey(key);

/**
 * The controls the PUT takes as a bare boolean and the GET wraps as {url, enabled}; graphql-rules.ts
 * pins its twin table to this list, so a control added there is added here first.
 */
const BOOLEAN_CONTROLS = [
  "enforce_admins",
  "required_linear_history",
  "allow_force_pushes",
  "allow_deletions",
  "block_creations",
  "required_conversation_resolution",
  "lock_branch",
  "allow_fork_syncing",
  "required_signatures",
] as const;
export type BooleanControl = (typeof BOOLEAN_CONTROLS)[number];
export const BOOLEAN_CONTROL_SET: ReadonlySet<string> = new Set(BOOLEAN_CONTROLS);

/**
 * The controls whose PUT schema marks the boolean nullable, null being the "off" spelling; the PUT
 * 422s null under any other control.
 */
export const NULLABLE_CONTROLS: ReadonlySet<string> = new Set<BooleanControl>([
  "enforce_admins",
  "allow_force_pushes",
]);
