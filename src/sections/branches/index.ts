/**
 * `branches:` section: classic branch protection, [{name, protection: {...} | null}]. Three keys
 * cannot ride the protection PUT; the one rules query fires only when an entry needs the GraphQL
 * surface, so a pure-REST declaration issues no GraphQL request at all.
 *
 * required_signatures                          -> GitHub's PUT silently drops it; its own POST/DELETE sub-endpoint applies it
 * force_push_bypassers, required_deployments   -> no REST field at all; one updateBranchProtectionRule mutation applies both
 * a WILDCARD name (contains `*`, `?`, or `[`)  -> invisible to every REST protection endpoint; the rule mutations, GraphQL-twin keys only
 */

import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import { matchesRejection } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import { loosen, type SectionMeta, type SectionModule } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { plainData } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { ENDPOINTS, MISSING_BRANCH } from "./endpoints.js";
import {
  type BranchesContext,
  type BranchesPlan,
  fetchRules,
  GRAPHQL,
  GRAPHQL_REVIEW_TWINS,
  GRAPHQL_STATUS_CHECK_TWINS,
  type GraphqlRun,
  hasRoutedGraphqlKeys,
  justified,
  planRoutedUpdate,
  planWildcardEntry,
  resolveActorIds,
  WILDCARD_KEY_SET,
  WILDCARD_KEYS,
} from "./graphql-rules.js";
import { type BranchConfig, BranchesConfig, type BranchProtectionConfig } from "./schema.js";

const REQUIRED_PROTECTION_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

/** Git refnames forbid `*`, `?`, and `[`, so a wildcard entry can never collide with a literal branch. */
export function isWildcardPattern(name: string): boolean {
  return /[*?[]/.test(name);
}

// GitHub spells this one list two ways inside required_status_checks and the GET returns both,
// so a declaration carrying either covers the other.
const STATUS_CHECK_ALIASES: Readonly<Record<string, string>> = {
  "required_status_checks.checks": "required_status_checks.contexts",
  "required_status_checks.contexts": "required_status_checks.checks",
};

/**
 * Nothing the replacing PUT would need to preserve: GitHub's default fill under a declared block,
 * an empty list, or an actor holder with empty lists. Any other nested object is a control that is
 * ON by its presence.
 */
function isEmptySetting(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "" || value === 0) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isPlainMapping(value)) {
    const keys = Object.keys(value);
    return (
      keys.length > 0 && keys.every((key) => ACTOR_LIST_KEYS.has(key) && isEmptySetting(value[key]))
    );
  }
  return false;
}

/**
 * The PUT replaces each nested object whole, so every non-empty live value at a path the
 * declaration omits, at any depth, would be reset by it.
 */
function omittedLiveDrift(
  declared: Record<string, unknown>,
  live: Record<string, unknown>,
  prefix: string,
  path = "",
): string[] {
  const drift: string[] = [];
  for (const [key, value] of Object.entries(live)) {
    const keyPath = path === "" ? key : `${path}.${key}`;
    if (Object.hasOwn(declared, key)) {
      const inner = declared[key];
      if (isPlainMapping(inner) && isPlainMapping(value)) {
        drift.push(...omittedLiveDrift(inner, value, prefix, keyPath));
      }
      continue;
    }
    const alias = STATUS_CHECK_ALIASES[keyPath];
    if (alias !== undefined && Object.hasOwn(declared, alias.slice(alias.lastIndexOf(".") + 1))) {
      continue;
    }
    if (isEmptySetting(value)) {
      continue;
    }
    drift.push(
      `${prefix}.${keyPath}: set live but omitted from the settings file, so apply would REMOVE it; add ${keyPath} to the branch's protection in the settings file to keep it`,
    );
  }
  return drift;
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const permission: SectionPermission = { repo: ["administration"] };

const LiveProtection = z.looseObject({
  required_signatures: z.looseObject({ enabled: z.boolean() }).optional(),
});

/** One item of the protected-branch listing; only the name is read (the protection is probed). */
const LiveBranchSummary = z.looseObject({ name: z.string() });

/** The snapshot note for the surface the REST reads cannot carry. */
const GRAPHQL_ONLY_NOTE =
  "protection.force_push_bypassers, protection.required_deployments, and wildcard rules ride the GraphQL rule " +
  "surface, which snapshot does not read; an omitted key leaves its live value untouched, so declare them to " +
  "manage them. A branch a wildcard rule protects is written here as a LITERAL entry carrying that rule's " +
  "protection (the REST reads name no pattern), and applying it would create a literal rule beside the " +
  "wildcard; replace such entries with one wildcard entry naming the pattern";

/** Built in the ONE place that decides whether the GraphQL run state exists, so no other site re-spells the predicate. */
type ClassifiedEntry =
  | { kind: "wildcard"; branch: BranchConfig; graphqlRun: GraphqlRun }
  | { kind: "literal"; branch: BranchConfig; routed: { graphqlRun: GraphqlRun } | null };

const WILDCARD_KEY_ERROR = (name: string, key: string): string =>
  `the wildcard entry "${name}" declares protection.${key}, which this section does not manage on wildcard rules; ` +
  `only the keys it can round-trip through the GraphQL rule mutations apply here: [${WILDCARD_KEYS.join(", ")}]. ` +
  "For actor lists and richer controls, prefer the rulesets section (the modern successor of classic protection)";

export const branchesSection = {
  key: "branches",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL,
  // The wildcard key sweep composes HERE, not in schema.ts: it reads the GraphQL translation tables,
  // which are this section's own machinery, and nothing outside them can reach a wildcard rule.
  shape: loosen(BranchesConfig).superRefine((declared, refineCtx) => {
    if (!Array.isArray(declared)) {
      return;
    }
    declared.forEach((entry: BranchConfig, index) => {
      if (!isWildcardPattern(entry.name) || entry.protection === null) {
        return;
      }
      const protection = entry.protection as Record<string, unknown>;
      for (const key of Object.keys(protection)) {
        if (!WILDCARD_KEY_SET.has(key)) {
          refineCtx.addIssue({
            code: "custom",
            path: [index, "protection", key],
            message: WILDCARD_KEY_ERROR(entry.name, key),
          });
        }
      }
      // The structured pairs translate NAMED sub-keys only, so an unknown sub-key would be silently
      // lost; a non-object value is rejected too, since nothing downstream could translate it.
      const nested: Array<[string, Record<string, string>]> = [
        ["required_status_checks", GRAPHQL_STATUS_CHECK_TWINS],
        ["required_pull_request_reviews", GRAPHQL_REVIEW_TWINS],
      ];
      for (const [key, twins] of nested) {
        const value = protection[key];
        if (value === null || value === undefined) {
          continue;
        }
        if (typeof value !== "object" || Array.isArray(value)) {
          refineCtx.addIssue({
            code: "custom",
            path: [index, "protection", key],
            message:
              `the wildcard entry "${entry.name}" declares protection.${key} as ` +
              `${Array.isArray(value) ? "a list" : JSON.stringify(value)}, but on a wildcard ` +
              `rule it must be a mapping of its sub-keys [${Object.keys(twins).join(", ")}], or ` +
              `null to turn the control off`,
          });
          continue;
        }
        for (const subKey of Object.keys(value)) {
          if (!(subKey in twins)) {
            refineCtx.addIssue({
              code: "custom",
              path: [index, "protection", key, subKey],
              message: WILDCARD_KEY_ERROR(entry.name, `${key}.${subKey}`),
            });
          }
        }
      }
    });
  }),
  async plan(ctx, desired): Promise<BranchesPlan> {
    // Two entries for one branch or pattern would overwrite each other's write on every run.
    rejectDuplicates(
      this,
      desired,
      (b) => b.name,
      (b) => b.name,
    );
    const plan: BranchesPlan = { ops: [], notes: [], drift: [] };
    // The SAME predicate that gates the one rules read classifies the entries, so every entry that
    // needs the run state gets it attached right here.
    const needsGraphql = (branch: BranchConfig): boolean =>
      isWildcardPattern(branch.name) || hasRoutedGraphqlKeys(branch.protection);
    let entries: ClassifiedEntry[];
    const graphqlRun: GraphqlRun | null = desired.some(needsGraphql)
      ? { rules: await fetchRules(ctx), repoId: null, actorIds: new Map(), lateActors: [] }
      : null;
    if (graphqlRun !== null) {
      const declaredPatterns = new Set(desired.map((branch) => branch.name));
      for (const pattern of [...(graphqlRun.rules?.keys() ?? [])].sort()) {
        if (isWildcardPattern(pattern) && !declaredPatterns.has(pattern)) {
          plan.notes.push(
            `undeclared classic protection rule "${pattern}" exists on the repo - declare it to manage it (this action never deletes undeclared rules)`,
          );
        }
      }
      entries = desired.map((branch) =>
        isWildcardPattern(branch.name)
          ? { kind: "wildcard", branch, graphqlRun }
          : {
              kind: "literal",
              branch,
              routed: hasRoutedGraphqlKeys(branch.protection) ? { graphqlRun } : null,
            },
      );
    } else {
      entries = desired.map((branch) => ({ kind: "literal", branch, routed: null }));
    }
    for (const entry of entries) {
      if (entry.kind === "wildcard") {
        await planWildcardEntry(ctx, entry.graphqlRun, entry.branch, plan);
        continue;
      }
      await planLiteralEntry(ctx, this, entry.routed, entry.branch, plan);
    }
    // Every actor a planned mutation resolves at execution resolves ahead of the plan's FIRST write,
    // whichever entry it belongs to: a misspelled actor fails while every branch's live protection
    // is still untouched, and the mutations' thunks then find the ids cached.
    const [lead, ...rest] = plan.ops;
    if (graphqlRun !== null && graphqlRun.lateActors.length > 0 && lead !== undefined) {
      plan.ops = [
        {
          ...lead,
          before: async (exec) => {
            await resolveActorIds(ctx, exec, graphqlRun, graphqlRun.lateActors);
          },
        },
        ...rest,
      ];
    }
    return plan;
  },
  // The listing also names branches only a ruleset protects, whose classic
  // protection probe answers 404: nothing to declare here. The engine notes
  // the denial that 404 could also be when every listed branch answers it.
  async snapshot(ctx) {
    const listed = parseLive(
      this,
      ENDPOINTS.listProtected,
      z.array(LiveBranchSummary),
      await ctx.read.listProtected.listAll({ query: { protected: "true" } }),
    );
    const entries: BranchConfig[] = [];
    for (const { name } of listed) {
      const probe = await ctx.read.getProtection.probeAbsent({ params: { branch: name } });
      if ("missing" in probe) {
        continue;
      }
      const live = parseLive(
        this,
        ENDPOINTS.getProtection,
        LiveProtection,
        probe.data,
        `branch "${name}"`,
      );
      entries.push({ name, protection: protectionSnapshot(live) });
    }
    if (entries.length === 0) {
      return { value: undefined, notes: [] };
    }
    return { value: entries, notes: [GRAPHQL_ONLY_NOTE] };
  },
} satisfies SectionModule<"branches", typeof ENDPOINTS, typeof GRAPHQL>;

/**
 * The declared protection a live GET body reads back as: flattenProtection's PUT vocabulary with
 * every top-level control that is off dropped, since the replacing PUT resets an omitted control
 * to off anyway.
 */
export function protectionSnapshot(live: Record<string, unknown>): BranchProtectionConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flattenProtection(live))) {
    if (value !== false && value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  // The engine validates the assembled document, so this cast is the projection boundary.
  return out as BranchProtectionConfig;
}

async function planLiteralEntry(
  ctx: BranchesContext,
  section: SectionMeta,
  routed: { graphqlRun: GraphqlRun } | null,
  branch: BranchConfig,
  plan: BranchesPlan,
): Promise<void> {
  const params = { branch: branch.name };
  const prefix = `branches[${branch.name}].protection`;
  const probe = await ctx.read.getProtection.probeAbsent({ params });
  if (branch.protection === null) {
    if ("missing" in probe) {
      return;
    }
    plan.ops.push({
      role: "removeProtection",
      params,
      drift: [
        `branches[${branch.name}]: protected live but the settings file declares protection: null; apply will remove the protection`,
      ],
      change: `removed protection from "${branch.name}"`,
    });
    return;
  }
  // GitHub's protection PUT silently DROPS required_signatures, and the other two routed keys have
  // no REST field at all, so none of them may ride the REST payload.
  const {
    required_signatures: requiredSignatures,
    force_push_bypassers: forcePushBypassers,
    required_deployments: requiredDeployments,
    ...payload
  } = branch.protection;
  // The classic API rejects payloads missing the core keys; null is a valid value for each.
  for (const key of REQUIRED_PROTECTION_KEYS) {
    if (!(key in payload)) {
      payload[key] = null;
    }
  }
  if (isPlainMapping(payload.required_status_checks)) {
    payload.required_status_checks = putStatusChecks(payload.required_status_checks);
  }
  let live: Record<string, unknown> | null = null;
  // GitHub does not document whether the PUT preserves the sub-resource and the GraphQL-only
  // fields, so a planned PUT re-applies every declared one.
  let putPlanned = false;
  if ("missing" in probe) {
    // Protection 404s for a missing BRANCH too; the advisory probe tells the two apart. A denied probe
    // is a 404 "Not Found" as well (fine-grained tokens conceal denied reads), so only GitHub's own
    // body counts and a denial keeps the plain unprotected reading.
    const branchProbe = await ctx.read.branchProbe.tryCall({ params });
    if ("error" in branchProbe && matchesRejection(MISSING_BRANCH, branchProbe.error)) {
      // The same failure the PUT raises without the Contents grant, so the outcome does not depend on it.
      throw new Error(`${section.key}: branches[${branch.name}]: ${MISSING_BRANCH.advice}`);
    }
    plan.ops.push({
      role: "putProtection",
      params,
      payload: plainData(payload),
      describe: `replacing protection for branch "${branch.name}"`,
      drift: [
        `branches[${branch.name}]: unprotected live but the settings file declares protection; apply will protect it`,
      ],
      change: `applied protection to "${branch.name}"`,
    });
    putPlanned = true;
  } else {
    live = flattenProtection(
      parseLive(
        section,
        ENDPOINTS.getProtection,
        LiveProtection,
        probe.data,
        `branch "${branch.name}"`,
      ),
    );
    // The protection GET OMITS required_signatures entirely when signed commits are not required,
    // so an absent live field means false; normalized so declared false does not read as drift.
    if (!("required_signatures" in live)) {
      live.required_signatures = false;
    }
    const declaredRest: Record<string, unknown> = { ...payload };
    for (const key of REQUIRED_PROTECTION_KEYS) {
      if (!(key in branch.protection)) {
        delete declaredRest[key];
      }
    }
    // The PUT replaces the whole protection, so live settings the declaration omits are REMOVED by
    // it: drift, not silence. The signature toggle is the one live field the PUT never touches.
    const { required_signatures: _liveSignatures, ...liveRest } = live;
    const restDrift = [
      ...subsetDiff(declaredRest, live, prefix),
      ...omittedLiveDrift(declaredRest, liveRest, prefix),
    ];
    const drift = justified(restDrift);
    if (drift !== null) {
      plan.ops.push({
        role: "putProtection",
        params,
        payload: plainData(payload),
        describe: `replacing protection for branch "${branch.name}"`,
        drift,
        change: `applied protection to "${branch.name}"`,
      });
      putPlanned = true;
    }
  }
  // The toggle applies through its sub-endpoint once the PUT has ensured the protection (and with it
  // the sub-resource) exists; an undeclared toggle leaves the live requirement alone.
  if (requiredSignatures !== undefined) {
    const sigDrift = subsetDiff(
      { required_signatures: requiredSignatures },
      { required_signatures: live?.required_signatures ?? false },
      prefix,
    );
    if (sigDrift.length === 0 && putPlanned) {
      sigDrift.push(
        `${prefix}.required_signatures: re-applied after the protection PUT (GitHub does not document whether the PUT preserves it)`,
      );
    }
    const drift = justified(sigDrift);
    if (drift !== null) {
      plan.ops.push(
        requiredSignatures
          ? {
              role: "sigPost",
              params,
              describe: `requiring signed commits on branch "${branch.name}"`,
              drift,
              change: `required signed commits on "${branch.name}"`,
            }
          : {
              role: "sigDelete",
              params,
              describe: `removing the signed-commit requirement from branch "${branch.name}"`,
              drift,
              change: `removed the signed-commit requirement from "${branch.name}"`,
            },
      );
    }
  }
  if (routed !== null) {
    planRoutedUpdate(ctx, routed.graphqlRun, plan, {
      name: branch.name,
      protection: branch.protection,
      prefix,
      putPlanned,
    });
  }
}

/**
 * GET /protection wraps booleans as {url, enabled} and expands actor lists into user/team/app
 * OBJECTS, while the PUT shape uses login/slug strings; both unwrap so check compares like with
 * like. Exported so the e2e state tests can assert their protectionFromPut inverts this exact function.
 */
export function flattenProtection(live: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(live)) {
    if (GET_ONLY_KEYS.has(key) || isUrlKey(key)) {
      continue;
    }
    out[key] = flattenValue(value);
  }
  const checks = out.required_status_checks;
  if (isPlainMapping(checks)) {
    const { enforcement_level: _level, ...status } = checks;
    out.required_status_checks = putStatusChecks(status);
  }
  return out;
}

/**
 * The required status checks in the PUT's spelling, applied to the live body and the declared
 * payload alike so both sides compare equal: "any App may report this check" reads back as app_id
 * null but the PUT takes -1 (an omitted app_id lets GitHub pin whichever App reported last), and
 * the PUT still requires `contexts` beside `checks`, so a body carrying only `checks` (a mock
 * storing a PUT verbatim) gets the names derived from it.
 */
function putStatusChecks(status: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(status.checks)) {
    return status;
  }
  const checks = status.checks.map((check) =>
    isPlainMapping(check) && check.app_id === null ? { ...check, app_id: -1 } : check,
  );
  const contexts = Array.isArray(status.contexts)
    ? status.contexts
    : checks.flatMap((check) =>
        isPlainMapping(check) && typeof check.context === "string" ? [check.context] : [],
      );
  return { ...status, checks, contexts };
}

// GET-only metadata the PUT vocabulary has no word for (url keys drop generically).
const GET_ONLY_KEYS: ReadonlySet<string> = new Set(["name", "enabled"]);

const isUrlKey = (key: string): boolean => key === "url" || key.endsWith("_url");

const ACTOR_NAME_KEYS = ["login", "slug"] as const;
const ACTOR_LIST_KEYS = new Set(["users", "teams", "apps"]);

function flattenValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenValue);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    "enabled" in record &&
    typeof record.enabled === "boolean" &&
    keys.every((k) => k === "enabled" || k === "url" || k.endsWith("_url"))
  ) {
    return record.enabled;
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (ACTOR_LIST_KEYS.has(key) && Array.isArray(inner)) {
      out[key] = inner.map((actor) => {
        if (typeof actor === "object" && actor !== null) {
          for (const nameKey of ACTOR_NAME_KEYS) {
            const name = (actor as Record<string, unknown>)[nameKey];
            if (typeof name === "string") {
              return name;
            }
          }
        }
        return actor;
      });
    } else if (isUrlKey(key)) {
      // URLs never appear in the PUT shape.
    } else {
      out[key] = flattenValue(inner);
    }
  }
  return out;
}
