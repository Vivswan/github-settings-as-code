/**
 * `rulesets:` section - upsert by name with full-payload PUT (a partial PUT
 * silently narrows a ruleset). Undeclared rulesets are NEVER deleted by
 * default; they are listed as notes so removal stays an explicit human
 * action. The wrapped `undeclared: delete` form hardens that to deletion.
 */

import { subsetDiff } from "../engine/diff.js";
import { type RulesetConfig, SettingsFile, type UndeclaredPolicyList } from "../schema.js";
import {
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  emptyResult,
  listAll,
  loosen,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
} from "./contract.js";

/**
 * Ruleset ref includes/excludes: the file may use short names ("staging",
 * "templates/*"); the API wants full refs. Native tokens (~DEFAULT_BRANCH,
 * ~ALL) and already-qualified refs pass through untouched.
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
  // Unknown (future) targets: never guess a prefix - pass through verbatim.
  return value;
}

/** Deep-copy a ruleset with normalized ref conditions (never mutates input). */
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

interface LiveRulesetSummary {
  id: number;
  name: string;
  source_type?: string;
}

const permission: SectionPermission = { repo: ["administration"] };

/**
 * Rules and bypass_actors pass through verbatim (future rule types included),
 * so a typo'd rules[].type reaches GitHub unchanged and comes back as a 422.
 * The hint names that failure class; the valid types live in the endpoint
 * docs, not here, so they cannot go stale.
 */
const RULES_HINT =
  'Usually this means a rules[].type GitHub does not recognize, or "parameters" that do not fit that rule type (rules pass through verbatim, so a typo reaches GitHub unchanged)';

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/rulesets",
    statuses: { 200: "the repository ruleset list" },
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

export const rulesetsSection: SectionModule<"rulesets"> = {
  key: "rulesets",
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(SettingsFile.shape.rulesets),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const { policy, entries } = undeclaredPolicy(
      desiredRaw as RulesetConfig[] | UndeclaredPolicyList<RulesetConfig>,
      defaultUndeclaredPolicy(this),
    );
    const desired = entries.map(normalizeRuleset);
    // Upsert matches by exact name, so two entries with the same name would
    // fight each other (create twice, then trade updates) on every run.
    rejectDuplicates(
      this,
      desired,
      (r) => r.name,
      (r) => r.name,
    );
    const summaries = (await listAll(ctx, this, ENDPOINTS.list)) as LiveRulesetSummary[];
    // Match and update anything not explicitly owned by another source (the
    // pre-knob upsert semantics; source_type is optional in the API type).
    // Deletion is gated harder below: only a summary the API explicitly
    // marks source_type "Repository" is ever deleted - a missing field is
    // not proof of ownership, and deletion cannot be undone.
    const repoRulesets = summaries.filter((r) => (r.source_type ?? "Repository") === "Repository");
    const idByName = new Map(repoRulesets.map((r) => [r.name, r.id]));

    for (const ruleset of desired) {
      const id = idByName.get(ruleset.name);
      if (id === undefined) {
        if (ctx.check) {
          result.drift.push(
            `rulesets[${ruleset.name}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.create, {
            payload: ruleset,
            describe: `creating ruleset "${ruleset.name}"`,
          });
          result.changes.push(`created ruleset "${ruleset.name}"`);
        }
        continue;
      }
      if (ctx.check) {
        const live = await call(ctx, this, ENDPOINTS.get, { params: { ruleset_id: String(id) } });
        result.drift.push(...subsetDiff(ruleset, live, `rulesets[${ruleset.name}]`));
      } else {
        await call(ctx, this, ENDPOINTS.update, {
          params: { ruleset_id: String(id) },
          payload: ruleset,
          describe: `updating ruleset "${ruleset.name}"`,
        });
        result.changes.push(`updated ruleset "${ruleset.name}" (id ${id})`);
      }
    }

    const declaredNames = new Set(desired.map((r) => r.name));
    for (const live of repoRulesets) {
      if (declaredNames.has(live.name)) {
        continue;
      }
      if (policy === "delete") {
        if (live.source_type !== "Repository") {
          result.notes.push(
            `ruleset "${live.name}" is undeclared, but the list response does not mark it source_type "Repository"; NOT deleting - only rulesets the API explicitly marks repository-owned are deleted; add it to the settings file to manage it, or delete it in GitHub if it should not exist`,
          );
          continue;
        }
        if (ctx.check) {
          result.drift.push(
            `rulesets[${live.name}]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it; add it to the settings file to keep it`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.remove, {
            params: { ruleset_id: String(live.id) },
            describe: `deleting undeclared ruleset "${live.name}"`,
          });
          result.changes.push(`DELETED undeclared ruleset "${live.name}"`);
        }
        continue;
      }
      result.notes.push(
        `ruleset "${live.name}" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it`,
      );
    }
    return result;
  },
};
