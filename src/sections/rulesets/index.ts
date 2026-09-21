/**
 * `rulesets:` section: upsert by name with a full-payload PUT. The write replaces the ruleset whole, so the
 * comparison sweeps the live body for a non-empty value the entry omits (drift in check, a refused write in apply);
 * target and enforcement are never omitted, since the slice fills them at parse.
 * The list carries summaries, so each matched ruleset is read whole before the comparison.
 */

import { z } from "zod";
import { agree } from "../../text.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { keyedBy } from "../contract/module.js";
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
  if (copy.bypass_actors !== undefined) {
    copy.bypass_actors = copy.bypass_actors.map(asStored);
  }
  return copy;
}

/**
 * An actor as GitHub stores it, on both operands of the comparison: the mode defaults to "always" (so an omitted
 * mode is compared, not silently reset by the PUT), and an OrganizationAdmin actor's id, which GitHub ignores and
 * answers as 1 or null, is 1.
 */
function asStored<A extends { actor_type?: unknown; actor_id?: unknown; bypass_mode?: unknown }>(
  actor: A,
): A {
  // Assignment keeps a present key's position, so the line quoting the live actor reads in GitHub's order.
  const stored = { ...actor };
  stored.bypass_mode = actor.bypass_mode ?? "always";
  if (actor.actor_type === "OrganizationAdmin") {
    stored.actor_id = 1;
  }
  return stored;
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
  // In GitHub's field order: the parsed shape sets the key order the drift line quotes a live actor in.
  bypass_actors: z
    .array(
      z.looseObject({
        actor_id: z.number().nullable().optional(),
        actor_type: z.string().optional(),
        bypass_mode: z.string().optional(),
      }),
    )
    .optional(),
});
type LiveRuleset = z.infer<typeof LiveRuleset>;

/**
 * The live body as the comparison reads it: its actors as stored (the same fold the declared side gets, so a live
 * OrganizationAdmin id of null cannot loop against the declared 1), and its bypass_actors key kept absent when GitHub
 * concealed it. A live body repeating a rule type has no pairing; GitHub keeps one rule per type, so that names a
 * defect worth a look.
 */
function comparableRuleset(live: LiveRuleset): LiveRuleset {
  const repeated = repeatedRuleTypes(live.rules);
  if (repeated !== undefined) {
    throw new Error(
      `rulesets: GitHub returned the ruleset "${live.name}" (id ${live.id}) with the ${repeated} more than once, ` +
        "so its rules cannot be paired by type; delete the repeated rule on GitHub, then re-run",
    );
  }
  return live.bypass_actors === undefined
    ? live
    : { ...live, bypass_actors: live.bypass_actors.map(asStored) };
}

// A rule type the vendored spec does not know passes through verbatim (schema.ts UnknownRule), so a
// typo'd rules[].type reaches GitHub unchanged and comes back as a 422 naming it; a known type's
// parameters were already checked at parse, so what is left for GitHub is what only the live repository can judge.
const RULES_HINT =
  'Usually this means a rules[].type GitHub does not recognize (a type the vendored spec does not know passes through verbatim, so a typo reaches GitHub unchanged), or "parameters" the live repository rejects for that rule type';

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
    // The full ruleset is the wire body (the PUT replaces it whole). The slice types rule
    // parameters and bypass actors as unknown passthrough; the factory proves the body plain at the payload.
    toWrite: (ruleset) => ({ ...normalizeRuleset(ruleset) }) as ListWrite<"name">,
    fromLive: (live) => comparableRuleset(live),
    // Rules pair by type, as the layered merge does; an actor is one per (type, id) pair, with no single identity field.
    matchBy: { rules: "type", bypass_actors: ["actor_type", "actor_id"] },
  },
  replaces: true,
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
  layering: { nested: { rules: keyedBy("type") } },
});
