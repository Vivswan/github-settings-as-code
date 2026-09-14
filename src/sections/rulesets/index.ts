/**
 * `rulesets:` section: upsert by name with a full-payload PUT, because a partial PUT silently narrows a
 * ruleset. The list carries summaries, so each matched ruleset is read whole before the comparison.
 */

import { z } from "zod";
import { agree } from "../../text.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { exactName, type ListWrite, listSection } from "../shared/list-section.js";
import { RulesetConfig } from "./schema.js";

/**
 * The file may use short names ("staging", "templates/*") where the API wants full refs; native
 * tokens (~DEFAULT_BRANCH, ~ALL) and already-qualified refs pass through untouched.
 */
export function normalizeRefName(value: string, target: string): string {
  if (value.startsWith("~") || value.startsWith("refs/")) {
    return value;
  }
  if (target === "tag") {
    return `refs/tags/${value}`;
  }
  if (target === "branch") {
    return `refs/heads/${value}`;
  }
  // Never guess a prefix for an unknown (future) target.
  return value;
}

export function normalizeRuleset(ruleset: RulesetConfig): RulesetConfig {
  const copy = structuredClone(ruleset);
  copy.target = copy.target ?? "branch";
  // The create endpoint requires enforcement; "active" is the useful default.
  copy.enforcement = copy.enforcement ?? "active";
  const target = copy.target;
  const refName = copy.conditions?.ref_name;
  if (refName && target !== "push") {
    if (refName.include) {
      refName.include = refName.include.map((v) => normalizeRefName(v, target));
    }
    if (refName.exclude) {
      refName.exclude = refName.exclude.map((v) => normalizeRefName(v, target));
    }
  }
  return copy;
}

/** The rule types a ruleset repeats; rules pair by type, so a repeat has no pairing. */
function repeatedRuleTypes(
  rules: readonly { readonly type: unknown }[] | undefined,
): string | undefined {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const rule of rules ?? []) {
    const type = String(rule.type);
    if (seen.has(type)) {
      repeated.add(type);
    }
    seen.add(type);
  }
  if (repeated.size === 0) {
    return undefined;
  }
  const types = [...repeated].map((type) => `"${type}"`).join(", ");
  return `${agree(repeated.size, "rule type", "rule types")} ${types}`;
}

/**
 * A summary or a full body: the list and the per-item GET share these fields. The API type leaves
 * `source_type` optional; a body without it reads as repository-owned, the only kind the repository
 * endpoints can write anyway.
 */
const LiveRuleset = z.looseObject({
  id: z.number(),
  name: z.string(),
  source_type: z.string().optional(),
  rules: z.array(z.looseObject({ type: z.string() })).optional(),
});
type LiveRuleset = z.infer<typeof LiveRuleset>;

/** A live body repeating a rule type has no pairing either; GitHub keeps one rule per type, so this names a defect worth a look. */
function pairableRuleset(live: LiveRuleset): LiveRuleset {
  const repeated = repeatedRuleTypes(live.rules);
  if (repeated !== undefined) {
    throw new Error(
      `rulesets: GitHub returned the ruleset "${live.name}" (id ${live.id}) with the ${repeated} more than once, ` +
        "so its rules cannot be paired by type; delete the repeated rule on GitHub, then re-run",
    );
  }
  return live;
}

// Rules pass through verbatim, so a typo'd rules[].type reaches GitHub unchanged and comes back as
// a 422; the valid types live in the endpoint docs, not here, so they cannot go stale.
const RULES_HINT =
  'Usually this means a rules[].type GitHub does not recognize, or "parameters" that do not fit that rule type (rules pass through verbatim, so a typo reaches GitHub unchanged)';

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/rulesets",
    statuses: { 200: "the repository ruleset list" },
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/rulesets",
    statuses: { 201: "ruleset created" },
    hints: { 422: RULES_HINT },
  },
  get: {
    route: "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    statuses: { 200: "the ruleset" },
  },
  update: {
    route: "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    statuses: { 200: "ruleset updated" },
    hints: { 422: RULES_HINT },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}",
    statuses: { 204: "ruleset deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const rulesetsSection = listSection({
  key: "rulesets",
  permission: { repo: ["administration"] },
  undeclaredDefault: "keep",
  noun: "ruleset",
  entry: RulesetConfig,
  live: LiveRuleset,
  endpoints: ENDPOINTS,
  identity: { field: "name", fold: exactName },
  address: (live) => ({ ruleset_id: String(live.id) }),
  lens: {
    // The full ruleset is the wire body (a partial PUT narrows a ruleset). The slice types rule
    // parameters and bypass actors as unknown passthrough; the factory proves the body plain at the payload.
    toWrite: (ruleset) => ({ ...normalizeRuleset(ruleset) }) as ListWrite<"name">,
    fromLive: (live) => pairableRuleset(live),
    // Rules pair by type, as the layered merge does; every other list pairs by shape.
    matchBy: { rules: "type" },
  },
  // GitHub keeps one rule per type, and the comparison pairs rules by it, so a repeated type is a settings-file mistake.
  conflicts: {
    declared: (writes) =>
      writes.flatMap((write) => {
        const repeated = repeatedRuleTypes(write.rules as { readonly type: unknown }[] | undefined);
        return repeated === undefined
          ? []
          : [
              `the ruleset "${write.name}" lists the ${repeated} more than once, and GitHub keeps one rule per type - declare each type once`,
            ];
      }),
  },
  // Only a ruleset the API marks repository-owned is this section's; an inherited one is managed where it is defined.
  foreign: (live) =>
    live.source_type === undefined || live.source_type === "Repository"
      ? null
      : {
          name: live.name,
          reason: `inherited from the ${live.source_type.toLowerCase()} (source_type "${live.source_type}"); manage it where it is defined`,
        },
  // GitHub omits the bypass_actors KEY (never `[]`) from a GET the token lacks write access for.
  concealed: (live) =>
    Object.hasOwn(live, "bypass_actors")
      ? []
      : [
          {
            field: "bypass_actors",
            reason: "GitHub returns it only to a token with write access to the ruleset",
            remedy: "grant Administration write",
          },
        ],
  prose: { undeclaredAction: "DELETE it" },
  layering: {
    combine: "merge",
    nested: {
      rules: {
        keys: (rule) => (typeof rule.type === "string" ? [rule.type] : null),
        keyField: "type",
        combine: "replace",
      },
    },
  },
});
