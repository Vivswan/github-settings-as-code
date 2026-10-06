/**
 * The planner's drift and the snapshot's entries both derive from classicViewOfRule, so a twin read
 * in one place is read in the other.
 */

import { err, ok, type Result } from "neverthrow";
import { isPlainObject } from "../../plain-data.js";
import { repoVariables } from "../contract/endpoints.js";
import { type SectionFailure, sectionFailure } from "../contract/errors.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import type { Read } from "../contract/plan.js";
import { type BranchesContext, type LiveRules, RuleNode } from "./graphql-ops.js";
import {
  GRAPHQL_BOOLEAN_TWINS,
  GRAPHQL_REVIEW_TWINS,
  type RoutedKey,
} from "./graphql-vocabulary.js";
import type { BranchProtectionConfig } from "./schema.js";

export function fetchRules(ctx: BranchesContext): Read<LiveRules> {
  return ctx.read.rulesQuery.listConnection(RuleNode, repoVariables(ctx)).andThen((read) =>
    // The declared NOT_FOUND: the denial surfaces at the first write instead of here.
    "error" in read ? ok(null) : indexRules(ctx, read.items),
  );
}

/** The snapshot's read: the op tolerates no outcome, so a denial fails the read with the grant advice. */
export function fetchRulesForSnapshot(ctx: BranchesContext): Read<Map<string, RuleNode>> {
  return ctx.read.rulesSnapshot.listConnection(RuleNode, repoVariables(ctx)).andThen((read) => {
    if ("error" in read) {
      throw new Error(
        "BUG: branches: the snapshot rules query declares no tolerated outcome, yet its read returned an error instead of failing",
      );
    }
    return indexRules(ctx, read.items);
  });
}

/** The rules by pattern under the duplicate-live guard: GitHub matches a pattern exactly, so the fold is the pattern itself. */
function indexRules(
  ctx: BranchesContext,
  rules: readonly RuleNode[],
): Result<Map<string, RuleNode>, SectionFailure> {
  for (const rule of rules) {
    // The nested allowance connection is read in one 100-node page; a rule beyond that would
    // silently truncate, so check would report phantom drift against the truncated list.
    if (rule.bypassForcePushAllowances.pageInfo.hasNextPage) {
      return err(
        sectionFailure(
          "live-shape",
          `branches: the live protection rule "${rule.pattern}" allows more than 100 force-push bypass actors, which this section cannot read back completely; trim the live allowance list below 100 to manage it here`,
        ),
      );
    }
  }
  return liveByIdentity(
    { key: ctx.section },
    "protection rule",
    rules,
    (rule) => rule.pattern,
    (rule) => liveIdentity(rule.pattern, { rule_id: rule.id }),
  );
}

export function bypassActorStrings(node: RuleNode): string[] {
  const out: string[] = [];
  for (const allowance of node.bypassForcePushAllowances.nodes ?? []) {
    const actor = allowance?.actor;
    if (!actor) {
      continue;
    }
    if (typeof actor.login === "string") {
      out.push(actor.login);
    } else if (typeof actor.combinedSlug === "string") {
      out.push(actor.combinedSlug);
    } else if (typeof actor.slug === "string") {
      out.push(`app/${actor.slug}`);
    }
  }
  return out;
}

/**
 * The real REST GET omits an off control where this view spells null; subsetDiff reads null, absent,
 * and "" as one empty value, so null stays for the clearer drift message. The e2e state test proves
 * the mock's REST-state projection round-trips through it.
 */
export function classicViewOfRule(node: RuleNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [classic, twin] of Object.entries(GRAPHQL_BOOLEAN_TWINS)) {
    out[classic] = node[twin];
  }
  out.required_status_checks =
    node.requiresStatusChecks === true
      ? {
          strict: node.requiresStrictStatusChecks,
          contexts: node.requiredStatusCheckContexts ?? [],
        }
      : null;
  if (node.requiresApprovingReviews === true) {
    const reviews: Record<string, unknown> = {};
    for (const [classic, twin] of Object.entries(GRAPHQL_REVIEW_TWINS)) {
      reviews[classic] = node[twin];
    }
    out.required_pull_request_reviews = reviews;
  } else {
    out.required_pull_request_reviews = null;
  }
  out.force_push_bypassers = [...bypassActorStrings(node)].sort();
  out.required_deployments =
    node.requiresDeployments === true
      ? { environments: node.requiredDeploymentEnvironments ?? [] }
      : null;
  return out;
}

/**
 * The two routed keys of a LITERAL entry as the snapshot declares them: only a non-empty allowance
 * list and a requirement that is on. An omitted routed key leaves the live value untouched (unlike
 * the replacing PUT, which resets an omitted control), so the file pins what is set.
 */
export function routedKeysSnapshot(node: RuleNode): Pick<BranchProtectionConfig, RoutedKey> {
  const view = classicViewOfRule(node);
  const out: Pick<BranchProtectionConfig, RoutedKey> = {};
  const actors = view.force_push_bypassers as string[];
  if (actors.length > 0) {
    out.force_push_bypassers = actors;
  }
  if (view.required_deployments !== null) {
    out.required_deployments = view.required_deployments as { environments: string[] };
  }
  return out;
}

/**
 * A WILDCARD rule as the snapshot declares it: the classic view with every control that is off
 * dropped and a nested null (an unset review count) omitted, so the entry carries only keys the
 * wildcard shape accepts and the check reads clean against the same rule.
 */
export function wildcardSnapshot(node: RuleNode): BranchProtectionConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(classicViewOfRule(node))) {
    if (value === false || value === null || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    out[key] = isPlainObject(value)
      ? Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== null))
      : value;
  }
  // The engine validates the assembled document, so this cast is the projection boundary.
  return out as BranchProtectionConfig;
}
