/** index.ts decides which entries reach this module; nothing here classifies entries. */

import { subsetDiff } from "../../engine/diff.js";
import { repoVariables } from "../contract/endpoints.js";
import { type GraphqlOpDecl, graphqlOp } from "../contract/graphql.js";
import type { ExecTools, Late, PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import type { ENDPOINTS } from "./endpoints.js";
import { type BranchConfig, type BranchProtectionConfig, parseBypassActor } from "./schema.js";

// --- The classic-to-GraphQL vocabulary -------------------------------------
//
// These tables are the EXPLICIT translation of the classic vocabulary to the mutation inputs.
// test/sections/graphql-queries.test.ts asserts the rules query selects every twin, and the e2e
// mock imports them to project stored REST state into rule nodes, so the two views cannot drift.

export const GRAPHQL_BOOLEAN_TWINS = {
  enforce_admins: "isAdminEnforced",
  required_linear_history: "requiresLinearHistory",
  allow_force_pushes: "allowsForcePushes",
  allow_deletions: "allowsDeletions",
  block_creations: "blocksCreations",
  required_conversation_resolution: "requiresConversationResolution",
  lock_branch: "lockBranch",
  allow_fork_syncing: "lockAllowsFetchAndMerge",
  required_signatures: "requiresCommitSignatures",
} as const;

export const GRAPHQL_REVIEW_TWINS = {
  required_approving_review_count: "requiredApprovingReviewCount",
  require_code_owner_reviews: "requiresCodeOwnerReviews",
  dismiss_stale_reviews: "dismissesStaleReviews",
  require_last_push_approval: "requireLastPushApproval",
} as const;

export const GRAPHQL_STATUS_CHECK_TWINS = {
  strict: "requiresStrictStatusChecks",
  contexts: "requiredStatusCheckContexts",
} as const;

export const WILDCARD_KEYS = [
  ...Object.keys(GRAPHQL_BOOLEAN_TWINS),
  "required_status_checks",
  "required_pull_request_reviews",
  "force_push_bypassers",
  "required_deployments",
] as const;

export const WILDCARD_KEY_SET: ReadonlySet<string> = new Set(WILDCARD_KEYS);

// --- GraphQL operations -------------------------------------------------------

/**
 * Classic protection IS a BranchProtectionRule upstream, so this lists literal and wildcard rules
 * alike. NOT_FOUND is tolerated so a fine-grained denial reads as "no rules visible" and surfaces
 * at the first write, the section's posture everywhere.
 */
const RULES_QUERY = graphqlOp<{ owner: string; repo: string }>()({
  name: "BranchProtectionRules",
  kind: "read",
  connection: { path: ["repository", "branchProtectionRules"] },
  outcomes: {
    ok: "the repository's classic branch protection rules",
    NOT_FOUND: "the repository is not visible to the token; read as no rules",
  },
  query: `query BranchProtectionRules($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    branchProtectionRules(first: 100, after: $cursor) {
      nodes {
        id
        pattern
        isAdminEnforced
        requiresLinearHistory
        allowsForcePushes
        allowsDeletions
        blocksCreations
        requiresConversationResolution
        lockBranch
        lockAllowsFetchAndMerge
        requiresCommitSignatures
        requiresStatusChecks
        requiresStrictStatusChecks
        requiredStatusCheckContexts
        requiresApprovingReviews
        requiredApprovingReviewCount
        requiresCodeOwnerReviews
        dismissesStaleReviews
        requireLastPushApproval
        requiresDeployments
        requiredDeploymentEnvironments
        bypassForcePushAllowances(first: 100) {
          nodes {
            actor {
              __typename
              ... on User { login }
              ... on Team { combinedSlug }
              ... on App { slug }
            }
          }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
});

/**
 * Execution-phase, like the two actor lookups: a fine-grained denial answers NOT_FOUND, which none
 * of the three tolerates, so they may only run where the posture puts the denial, at the first write.
 */
const REPO_LOOKUP = graphqlOp<{ owner: string; repo: string }>()({
  name: "BranchProtectionRepository",
  kind: "read",
  phase: "execution",
  outcomes: { ok: "the repository's GraphQL node id" },
  query: `query BranchProtectionRepository($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) { id }
}`,
});

/**
 * REST /users/{username} can still carry a legacy node_id for old accounts (the mutation would
 * answer a deprecation warning), so users resolve through GraphQL. The repository selection routes
 * the read: every repo-addressed read takes $owner/$repo.
 */
const ACTOR_USER = graphqlOp<{ owner: string; repo: string; login: string }>()({
  name: "BranchProtectionActorUser",
  kind: "read",
  phase: "execution",
  outcomes: {
    ok: "the user's node id",
    NOT_FOUND: "no user with this login, or the token cannot see it",
  },
  denialHint:
    "a denial here can also mean the declared force_push_bypassers actor does not exist; check the actor spelling in the settings file",
  query: `query BranchProtectionActorUser($owner: String!, $repo: String!, $login: String!) {
  repository(owner: $owner, name: $repo) { id }
  user(login: $login) { id }
}`,
});

const ACTOR_TEAM = graphqlOp<{ owner: string; repo: string; org: string; team: string }>()({
  name: "BranchProtectionActorTeam",
  kind: "read",
  phase: "execution",
  outcomes: {
    ok: "the team's node id",
    NOT_FOUND: "no organization with this login, or the token cannot see it",
  },
  denialHint:
    "a denial here can also mean the declared force_push_bypassers actor's organization does not exist; check the actor spelling in the settings file",
  query: `query BranchProtectionActorTeam($owner: String!, $repo: String!, $org: String!, $team: String!) {
  repository(owner: $owner, name: $repo) { id }
  organization(login: $org) { team(slug: $team) { id } }
}`,
});

/**
 * The create and update payloads re-read the persisted rule, so selecting
 * requiredDeploymentEnvironments IS the post-mutation read-back the silent-drop check needs (GitHub
 * drops names of environments that do not exist without failing the mutation).
 */
const CREATE_RULE = graphqlOp<{ input: Record<string, unknown> }>()({
  name: "CreateBranchProtectionRule",
  kind: "write",
  outcomes: {
    ok: "rule created",
    UNPROCESSABLE: "GitHub rejected the rule (e.g. a duplicate pattern)",
  },
  query: `mutation CreateBranchProtectionRule($input: CreateBranchProtectionRuleInput!) {
  createBranchProtectionRule(input: $input) {
    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }
  }
}`,
});

const UPDATE_RULE = graphqlOp<{ input: Record<string, unknown> }>()({
  name: "UpdateBranchProtectionRule",
  kind: "write",
  outcomes: {
    ok: "rule updated",
    NOT_FOUND: "no rule with this node id",
    UNPROCESSABLE: "GitHub rejected the update",
  },
  query: `mutation UpdateBranchProtectionRule($input: UpdateBranchProtectionRuleInput!) {
  updateBranchProtectionRule(input: $input) {
    branchProtectionRule { id pattern requiresDeployments requiredDeploymentEnvironments }
  }
}`,
});

const DELETE_RULE = graphqlOp<{ input: Record<string, unknown> }>()({
  name: "DeleteBranchProtectionRule",
  kind: "write",
  outcomes: { ok: "rule deleted", NOT_FOUND: "no rule with this node id" },
  query: `mutation DeleteBranchProtectionRule($input: DeleteBranchProtectionRuleInput!) {
  deleteBranchProtectionRule(input: $input) { clientMutationId }
}`,
});

export const GRAPHQL = {
  rulesQuery: RULES_QUERY,
  repoLookup: REPO_LOOKUP,
  actorUser: ACTOR_USER,
  actorTeam: ACTOR_TEAM,
  createRule: CREATE_RULE,
  updateRule: UPDATE_RULE,
  deleteRule: DELETE_RULE,
} as const satisfies Record<string, GraphqlOpDecl>;

export function hasRoutedGraphqlKeys(protection: BranchProtectionConfig | null): boolean {
  return (
    protection !== null &&
    (protection.force_push_bypassers !== undefined || protection.required_deployments !== undefined)
  );
}

type RuleNode = Record<string, unknown>;

/**
 * null when the rules query answered its tolerated NOT_FOUND: unreadable is not the same as empty,
 * so a declared routed key must not read as clean against it.
 */
type LiveRules = Map<string, RuleNode> | null;

export interface GraphqlRun {
  rules: LiveRules;
  repoId: string | null;
  actorIds: Map<string, string>;
  /**
   * Every bypass actor a planned mutation resolves at execution, appended by ruleVariables() as it
   * seals one; plan() resolves them all ahead of the FIRST write, whichever entry they belong to.
   */
  lateActors: string[];
}

export type BranchesContext = PlanContext<typeof ENDPOINTS, typeof GRAPHQL>;

export type BranchesPlan = SectionPlan<PlannedOp<typeof ENDPOINTS, typeof GRAPHQL>>;

export async function fetchRules(ctx: BranchesContext): Promise<LiveRules> {
  const read = await ctx.read.rulesQuery.listConnection(repoVariables(ctx));
  if ("error" in read) {
    // The declared NOT_FOUND: the denial surfaces at the first write instead of here.
    return null;
  }
  const byPattern = new Map<string, RuleNode>();
  for (const node of read.items) {
    if (typeof node === "object" && node !== null) {
      const rule = node as RuleNode;
      // The nested allowance connection is read in one 100-node page; a rule beyond that would
      // silently truncate, so check would report phantom drift against the truncated list.
      const allowances = rule.bypassForcePushAllowances as
        | { pageInfo?: { hasNextPage?: unknown } }
        | undefined;
      if (allowances?.pageInfo?.hasNextPage === true) {
        throw new Error(
          `branches: the live protection rule "${String(rule.pattern)}" allows more than 100 force-push bypass actors, which this section cannot read back completely; trim the live allowance list below 100 to manage it here`,
        );
      }
      byPattern.set(String(rule.pattern), rule);
    }
  }
  return byPattern;
}

export function bypassActorStrings(node: RuleNode): string[] {
  const allowances = (node.bypassForcePushAllowances as { nodes?: unknown } | undefined)?.nodes;
  if (!Array.isArray(allowances)) {
    return [];
  }
  const out: string[] = [];
  for (const allowance of allowances) {
    const actor = (allowance as { actor?: Record<string, unknown> } | null)?.actor;
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
          contexts: Array.isArray(node.requiredStatusCheckContexts)
            ? node.requiredStatusCheckContexts
            : [],
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
      ? {
          environments: Array.isArray(node.requiredDeploymentEnvironments)
            ? node.requiredDeploymentEnvironments
            : [],
        }
      : null;
  return out;
}

/** Shape validation already restricted a wildcard entry's keys, so an unknown key here is a bug. */
function translateWildcardProtection(protection: BranchProtectionConfig): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(protection)) {
    if (key === "force_push_bypassers" || key === "required_deployments") {
      continue;
    }
    const booleanTwin = GRAPHQL_BOOLEAN_TWINS[key as keyof typeof GRAPHQL_BOOLEAN_TWINS];
    if (booleanTwin !== undefined) {
      input[booleanTwin] = value;
      continue;
    }
    if (key === "required_status_checks") {
      if (value === null) {
        input.requiresStatusChecks = false;
      } else {
        input.requiresStatusChecks = true;
        const checks = value as Record<string, unknown>;
        for (const [classic, twin] of Object.entries(GRAPHQL_STATUS_CHECK_TWINS)) {
          if (classic in checks) {
            input[twin] = checks[classic];
          }
        }
      }
      continue;
    }
    if (key === "required_pull_request_reviews") {
      if (value === null) {
        input.requiresApprovingReviews = false;
      } else {
        input.requiresApprovingReviews = true;
        const reviews = value as Record<string, unknown>;
        for (const [classic, twin] of Object.entries(GRAPHQL_REVIEW_TWINS)) {
          if (classic in reviews) {
            input[twin] = reviews[classic];
          }
        }
      }
      continue;
    }
    throw new Error(`BUG: wildcard protection key "${key}" escaped shape validation`);
  }
  return input;
}

function deploymentInputFields(
  declared: NonNullable<BranchProtectionConfig["required_deployments"]> | null,
): Record<string, unknown> {
  if (declared === null) {
    return { requiresDeployments: false, requiredDeploymentEnvironments: [] };
  }
  return { requiresDeployments: true, requiredDeploymentEnvironments: [...declared.environments] };
}

/**
 * GitHub canonicalizes actor and environment names, so a declared "Octocat" reads back as "octocat"
 * and must not drift. Duplicates are rejected upfront by the shape, so sorted-lowercase comparison is exact.
 */
function sameNamesFold(declared: readonly string[], live: readonly string[]): boolean {
  if (declared.length !== live.length) {
    return false;
  }
  const a = declared.map((name) => name.toLowerCase()).sort();
  const b = live.map((name) => name.toLowerCase()).sort();
  return a.every((name, i) => name === b[i]);
}

type MutationPayloadKey = "createBranchProtectionRule" | "updateBranchProtectionRule";

/**
 * GitHub accepts requiredDeploymentEnvironments names of environments that do not exist and DROPS
 * them without failing the mutation (verified live), so the payload's re-read is compared against
 * the declaration. The environments section runs first, so same-file environments exist here.
 */
function verifyDeploymentReadback(
  entryName: string,
  declared: NonNullable<BranchProtectionConfig["required_deployments"]> | null,
  response: unknown,
  payloadKey: MutationPayloadKey,
): void {
  const payload = (response as Record<string, unknown> | null)?.[payloadKey];
  const rule = (payload as Record<string, unknown> | null | undefined)?.branchProtectionRule as
    | RuleNode
    | null
    | undefined;
  if (typeof rule !== "object" || rule === null) {
    throw new Error(
      `branches[${entryName}].protection.required_deployments: the mutation returned no rule to read back, so the applied deployment requirement cannot be verified; re-run the workflow, and retry later if it persists`,
    );
  }
  const echoed = Array.isArray(rule.requiredDeploymentEnvironments)
    ? (rule.requiredDeploymentEnvironments as unknown[]).map(String)
    : [];
  if (declared === null) {
    if (rule.requiresDeployments === true) {
      throw new Error(
        `branches[${entryName}].protection.required_deployments: declared null (not required) but the rule still requires deployments to [${echoed.join(", ")}] after the mutation; re-run the workflow, and report this if it persists`,
      );
    }
    return;
  }
  const echoedFold = new Set(echoed.map((name) => name.toLowerCase()));
  const dropped = declared.environments.filter((name) => !echoedFold.has(name.toLowerCase()));
  if (dropped.length > 0) {
    throw new Error(
      `branches[${entryName}].protection.required_deployments: GitHub silently dropped [${dropped.join(", ")}] ` +
        "from the required deployment environments because no environment with that name exists on the repository. " +
        "Declare the environment in this settings file's environments: section (it applies before branches), " +
        "or create it on the repository first",
    );
  }
  if (rule.requiresDeployments !== true || !sameNamesFold(declared.environments, echoed)) {
    throw new Error(
      `branches[${entryName}].protection.required_deployments: the settings file requires deployments to ` +
        `[${declared.environments.join(", ")}] but after the mutation the rule ` +
        `${rule.requiresDeployments === true ? `requires [${echoed.join(", ")}]` : "does not require deployments"}; ` +
        "re-run the workflow, and report this if it persists",
    );
  }
}

function routedKeyDrift(
  prefix: string,
  protection: BranchProtectionConfig,
  rules: LiveRules,
  pattern: string,
): string[] {
  const drift: string[] = [];
  if (rules === null) {
    // An unreadable view can never read as clean, so the declared value is written regardless.
    for (const key of ["force_push_bypassers", "required_deployments"] as const) {
      if (protection[key] !== undefined) {
        drift.push(
          `${prefix}.${key}: the live rule cannot be read (the rules query answered not found); apply will set the declared value`,
        );
      }
    }
    return drift;
  }
  const node = rules.get(pattern);
  const declaredActors = protection.force_push_bypassers;
  if (declaredActors !== undefined) {
    const live = node ? [...bypassActorStrings(node)].sort() : [];
    if (!sameNamesFold(declaredActors, live)) {
      drift.push(
        `${prefix}.force_push_bypassers: the settings file declares [${[...declaredActors].sort().join(", ")}] but the live rule allows [${live.join(
          ", ",
        )}]; apply will replace the allowance list`,
      );
    }
  }
  const declaredDeployments = protection.required_deployments;
  if (declaredDeployments !== undefined) {
    const liveOn = node?.requiresDeployments === true;
    const liveEnvs = (
      Array.isArray(node?.requiredDeploymentEnvironments)
        ? (node.requiredDeploymentEnvironments as unknown[]).map(String)
        : []
    ).sort();
    if (declaredDeployments === null) {
      if (liveOn) {
        drift.push(
          `${prefix}.required_deployments: declared null (not required) but the live rule requires deployments to [${liveEnvs.join(
            ", ",
          )}]; apply will turn the requirement off`,
        );
      }
    } else if (!liveOn || !sameNamesFold(declaredDeployments.environments, liveEnvs)) {
      drift.push(
        `${prefix}.required_deployments: the settings file requires deployments to [${[
          ...declaredDeployments.environments,
        ]
          .sort()
          .join(
            ", ",
          )}] but the live rule ${liveOn ? `requires [${liveEnvs.join(", ")}]` : "does not require deployments"}; apply will set the declared list`,
      );
    }
  }
  return drift;
}

/**
 * Cached per run under the case-folded string: GitHub canonicalizes actor names. A user or team read
 * also selects the repository's node id, which a later rule CREATE reuses instead of a dedicated lookup.
 *
 * user  -> GraphQL (REST /users can still carry a legacy node_id; see ACTOR_USER)
 * team  -> GraphQL
 * app   -> the public REST lookup (legacy-id caveat on appLookup in endpoints.ts); no repository id
 */
async function resolveActorId(
  ctx: BranchesContext,
  exec: ExecTools,
  graphqlRun: GraphqlRun,
  raw: string,
): Promise<string> {
  const cacheKey = raw.toLowerCase();
  const cached = graphqlRun.actorIds.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const actor = parseBypassActor(raw);
  if (actor === null) {
    throw new Error(`BUG: force_push_bypassers actor "${raw}" escaped shape validation`);
  }
  let id: unknown;
  if (actor.kind === "user") {
    const data = await ctx.read.actorUser.call(
      exec,
      { ...repoVariables(ctx), login: actor.login },
      { describe: `resolving force-push bypass user "${raw}"` },
    );
    adoptRepoId(graphqlRun, data);
    id = (data.user as Record<string, unknown> | null)?.id;
  } else if (actor.kind === "team") {
    const data = await ctx.read.actorTeam.call(
      exec,
      { ...repoVariables(ctx), org: actor.org, team: actor.team },
      { describe: `resolving force-push bypass team "${raw}"` },
    );
    adoptRepoId(graphqlRun, data);
    const team = (data.organization as Record<string, unknown> | null)?.team as Record<
      string,
      unknown
    > | null;
    if (!team) {
      throw new Error(
        `branches: force_push_bypassers actor "${raw}": the organization "${actor.org}" has no team with slug "${actor.team}" (or the token cannot see it); check the actor spelling in the settings file`,
      );
    }
    id = team.id;
  } else {
    const result = await ctx.read.appLookup.tryCall(exec, {
      params: { app_slug: actor.slug },
      describe: `resolving force-push bypass App "${raw}"`,
    });
    if ("error" in result) {
      throw new Error(
        `branches: force_push_bypassers actor "${raw}": no GitHub App with slug "${actor.slug}" exists; check the actor spelling in the settings file`,
      );
    }
    id = (result.data as Record<string, unknown> | null)?.node_id;
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `branches: force_push_bypassers actor "${raw}": the ${actor.kind === "app" ? "App lookup" : "GraphQL lookup"} succeeded but returned no node id, so the allowance cannot be applied; re-run the workflow, and report this if it persists`,
    );
  }
  graphqlRun.actorIds.set(cacheKey, id);
  return id;
}

function adoptRepoId(graphqlRun: GraphqlRun, data: Record<string, unknown>): void {
  const id = (data.repository as Record<string, unknown> | null)?.id;
  if (graphqlRun.repoId === null && typeof id === "string" && id.length > 0) {
    graphqlRun.repoId = id;
  }
}

/**
 * Read at EXECUTION time when the plan-time fetch did not carry the rule: a PUT planned earlier may
 * have created it, or the rules query answered its tolerated NOT_FOUND.
 */
async function lateRuleId(ctx: BranchesContext, pattern: string): Promise<unknown> {
  const node = (await fetchRules(ctx))?.get(pattern);
  if (node === undefined) {
    throw new Error(
      `branches[${pattern}]: the branch is protected but no branch protection rule with that ` +
        `pattern is visible through GraphQL, so its GraphQL-only fields cannot be set; check ` +
        `that the token can read branch protection rules, re-run the workflow, and report this ` +
        `if it persists`,
    );
  }
  return node.id;
}

/** IN DECLARED ORDER, one lookup at a time, so the request log stays deterministic. */
export async function resolveActorIds(
  ctx: BranchesContext,
  exec: ExecTools,
  graphqlRun: GraphqlRun,
  actors: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const actor of actors) {
    ids.push(await resolveActorId(ctx, exec, graphqlRun, actor));
  }
  return ids;
}

function wildcardInput(protection: BranchProtectionConfig): Record<string, unknown> {
  const input = translateWildcardProtection(protection);
  if (protection.required_deployments !== undefined) {
    Object.assign(input, deploymentInputFields(protection.required_deployments));
  }
  return input;
}

type RuleVariables = { input: Record<string, unknown> } | Late<{ input: Record<string, unknown> }>;

/**
 * Check mode must never issue the execution-time lookups (actor ids, the repository id, a rule id
 * the plan-time fetch did not carry): a fine-grained denial answers NOT_FOUND where the posture
 * promises the denial surfaces at the first write. A plain value when nothing is late, so the
 * idempotence proof compares it by field.
 */
function ruleVariables(
  ctx: BranchesContext,
  graphqlRun: GraphqlRun,
  fields: Record<string, unknown>,
  actors: readonly string[] | undefined,
  late?: (exec: ExecTools) => Promise<Record<string, unknown>>,
): RuleVariables {
  if (actors === undefined && late === undefined) {
    return { input: fields };
  }
  if (actors !== undefined) {
    graphqlRun.lateActors.push(...actors);
  }
  // The actors resolve first: a user or team read also selects the repository's node id, which
  // spares a create its dedicated lookup (adoptRepoId).
  return async (exec) => ({
    input: {
      ...fields,
      ...(actors === undefined
        ? {}
        : { bypassForcePushActorIds: await resolveActorIds(ctx, exec, graphqlRun, actors) }),
      ...(late === undefined ? {} : await late(exec)),
    },
  });
}

async function repositoryNodeId(
  ctx: BranchesContext,
  exec: ExecTools,
  graphqlRun: GraphqlRun,
): Promise<string> {
  if (graphqlRun.repoId === null) {
    const data = await ctx.read.repoLookup.call(exec, repoVariables(ctx), {
      describe: "resolving the repository's GraphQL node id",
    });
    const id = (data.repository as Record<string, unknown> | null)?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        "branches: the repository lookup returned no GraphQL node id, so no protection rule can be created; re-run the workflow and retry if it persists",
      );
    }
    graphqlRun.repoId = id;
  }
  return graphqlRun.repoId;
}

/** Every planned write carries a non-empty drift list as its justification. */
export function justified(lines: readonly string[]): readonly [string, ...string[]] | null {
  const [first, ...rest] = lines;
  return first === undefined ? null : [first, ...rest];
}

function verifiedChange(
  line: string,
  entryName: string,
  declared: BranchProtectionConfig["required_deployments"],
  payloadKey: MutationPayloadKey,
): string | ((response: unknown) => string) {
  if (declared === undefined) {
    return line;
  }
  return (response) => {
    verifyDeploymentReadback(entryName, declared, response, payloadKey);
    return line;
  };
}

export function planRoutedUpdate(
  ctx: BranchesContext,
  graphqlRun: GraphqlRun,
  plan: BranchesPlan,
  entry: {
    name: string;
    protection: BranchProtectionConfig;
    prefix: string;
    putPlanned: boolean;
  },
): void {
  const { name, protection, prefix, putPlanned } = entry;
  const { force_push_bypassers: forcePushBypassers, required_deployments: requiredDeployments } =
    protection;
  const node = graphqlRun.rules?.get(name);
  const routedKeys = [
    ...(forcePushBypassers === undefined ? [] : ["force_push_bypassers"]),
    ...(requiredDeployments === undefined ? [] : ["required_deployments"]),
  ].join(" and ");
  const routedDrift = routedKeyDrift(prefix, protection, graphqlRun.rules, name);
  if (routedDrift.length === 0 && putPlanned) {
    routedDrift.push(
      `${prefix}: ${routedKeys} re-applied after the protection PUT (GitHub does not document whether the PUT preserves them)`,
    );
  }
  const drift = justified(routedDrift);
  if (drift === null) {
    return;
  }
  const deploymentFields =
    requiredDeployments === undefined ? {} : deploymentInputFields(requiredDeployments);
  plan.ops.push({
    role: "updateRule",
    describe: `setting the GraphQL-only protection fields of branch "${name}"`,
    // A rule the plan-time fetch did not carry is looked up at execution: the PUT planned above may
    // create it, or the rules query answered NOT_FOUND.
    variables:
      node !== undefined
        ? ruleVariables(
            ctx,
            graphqlRun,
            { branchProtectionRuleId: node.id, ...deploymentFields },
            forcePushBypassers,
          )
        : ruleVariables(ctx, graphqlRun, deploymentFields, forcePushBypassers, async () => ({
            branchProtectionRuleId: await lateRuleId(ctx, name),
          })),
    drift,
    change: verifiedChange(
      `set ${routedKeys} on "${name}"`,
      name,
      requiredDeployments,
      "updateBranchProtectionRule",
    ),
  });
}

export async function planWildcardEntry(
  ctx: BranchesContext,
  graphqlRun: GraphqlRun,
  branch: BranchConfig,
  plan: BranchesPlan,
): Promise<void> {
  const pattern = branch.name;
  const prefix = `branches[${pattern}].protection`;
  const node = graphqlRun.rules?.get(pattern);
  if (branch.protection === null) {
    if (node === undefined) {
      return;
    }
    plan.ops.push({
      role: "deleteRule",
      variables: { input: { branchProtectionRuleId: node.id } },
      describe: `deleting the protection rule "${pattern}"`,
      drift: [
        `branches[${pattern}]: a live rule matches this pattern but the settings file declares protection: null; apply will delete the rule`,
      ],
      change: `deleted protection rule "${pattern}"`,
    });
    return;
  }
  const deployments = branch.protection.required_deployments;
  const actors = branch.protection.force_push_bypassers;
  const fields = wildcardInput(branch.protection);
  if (node === undefined) {
    plan.ops.push({
      role: "createRule",
      variables: ruleVariables(ctx, graphqlRun, { pattern, ...fields }, actors, async (exec) => ({
        repositoryId: await repositoryNodeId(ctx, exec, graphqlRun),
      })),
      describe: `creating the protection rule "${pattern}"`,
      drift: [
        `branches[${pattern}]: no live rule matches this pattern but the settings file declares protection; apply will create the rule`,
      ],
      change: verifiedChange(
        `created protection rule "${pattern}"`,
        pattern,
        deployments,
        "createBranchProtectionRule",
      ),
    });
    return;
  }
  const declared: Record<string, unknown> = { ...branch.protection };
  delete declared.force_push_bypassers;
  delete declared.required_deployments;
  const drift = justified([
    ...subsetDiff(declared, classicViewOfRule(node), prefix),
    ...routedKeyDrift(prefix, branch.protection, graphqlRun.rules, pattern),
  ]);
  if (drift === null) {
    return;
  }
  plan.ops.push({
    role: "updateRule",
    variables: ruleVariables(
      ctx,
      graphqlRun,
      { branchProtectionRuleId: node.id, ...fields },
      actors,
    ),
    describe: `updating the protection rule "${pattern}"`,
    drift,
    change: verifiedChange(
      `updated protection rule "${pattern}"`,
      pattern,
      deployments,
      "updateBranchProtectionRule",
    ),
  });
}
