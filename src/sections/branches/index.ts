/**
 * `branches:` section - classic branch protection, Probot schema:
 * [{name, protection: {...} | null}]. The protection PUT requires the four
 * core keys to be present (null is a valid value); protection: null removes
 * protection entirely. Three surfaces are REST-invisible and route through
 * GraphQL instead:
 *   - required_signatures is stripped from the PUT (GitHub silently drops
 *     it) and applied through its own POST/DELETE sub-endpoint;
 *   - force_push_bypassers and required_deployments have no REST field at
 *     all, so both are stripped from the PUT and applied through ONE
 *     updateBranchProtectionRule mutation after it;
 *   - a WILDCARD entry (its name contains one of the characters git
 *     refnames forbid: `*`, `?`, `[`) is invisible to every REST protection
 *     endpoint, so it reconciles entirely through the GraphQL rule
 *     mutations, its protection restricted to the keys with exact GraphQL
 *     twins (GRAPHQL_BOOLEAN_TWINS and the two structured pairs below).
 * The one rules query behind all of this fires only when an entry needs it;
 * a pure-REST declaration issues no GraphQL request at all.
 */

import { subsetDiff } from "../../engine/diff.js";
import {
  type BranchConfig,
  type BranchProtectionConfig,
  parseBypassActor,
  SettingsFile,
} from "../../schema.js";
import {
  beginRun,
  call,
  callGraphql,
  type EndpointDecl,
  expand,
  type GraphqlOpDecl,
  graphqlOp,
  listGraphqlConnection,
  loosen,
  probeAbsent,
  rejectDuplicates,
  repoVariables,
  type SectionContext,
  type SectionMeta,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  tryCall,
} from "../contract.js";

const REQUIRED_PROTECTION_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

/**
 * True for a name no literal git branch can carry (refnames forbid `*`, `?`,
 * and `[`), so a wildcard entry can never collide with a literal one.
 */
export function isWildcardPattern(name: string): boolean {
  return /[*?[]/.test(name);
}

// --- The classic-to-GraphQL vocabulary -------------------------------------
//
// A wildcard entry keeps the classic snake_case protection vocabulary; these
// tables are its EXPLICIT translation to the BranchProtectionRule mutation
// inputs, verified field for field against GitHub's published schema by
// test/sections/graphql-queries.test.ts, whose twin-superset test asserts
// the rules query below selects every twin.
// The e2e mock imports them to project stored REST state into GraphQL rule
// nodes, so the two views cannot drift.

/** Classic boolean toggles with a same-meaning GraphQL rule field. */
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

/** required_pull_request_reviews sub-keys with a GraphQL twin. */
export const GRAPHQL_REVIEW_TWINS = {
  required_approving_review_count: "requiredApprovingReviewCount",
  require_code_owner_reviews: "requiresCodeOwnerReviews",
  dismiss_stale_reviews: "dismissesStaleReviews",
  require_last_push_approval: "requireLastPushApproval",
} as const;

/** required_status_checks sub-keys with a GraphQL twin. */
export const GRAPHQL_STATUS_CHECK_TWINS = {
  strict: "requiresStrictStatusChecks",
  contexts: "requiredStatusCheckContexts",
} as const;

/** Every protection key a WILDCARD entry may declare. */
const WILDCARD_KEYS = [
  ...Object.keys(GRAPHQL_BOOLEAN_TWINS),
  "required_status_checks",
  "required_pull_request_reviews",
  "force_push_bypassers",
  "required_deployments",
] as const;

const WILDCARD_KEY_SET: ReadonlySet<string> = new Set(WILDCARD_KEYS);

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  getProtection: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "the branch protection", 404: "the branch is unprotected or does not exist" },
  },
  putProtection: {
    route: "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 200: "protection replaced" },
    hints: {
      422: 'Usually a sub-object is missing a required half: "required_status_checks" needs both "strict" and "contexts", "required_pull_request_reviews" values must fit their documented shapes, and "restrictions" needs "users" and "teams" lists (or declare the whole key as null)',
    },
  },
  removeProtection: {
    route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection",
    statuses: { 204: "protection removed" },
  },
  // required_signatures lives on its own sub-resource (the protection PUT
  // silently drops the key), so the declared boolean is applied through
  // these two calls right after a successful PUT.
  sigPost: {
    route: "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
    statuses: { 200: "signed commits now required" },
  },
  sigDelete: {
    route: "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures",
    statuses: { 204: "signed-commit requirement removed" },
  },
  // Advisory branch-existence probe: called directly via tryRequest (not
  // through the enforced helpers), declared here so the dictionary is
  // complete for downstream mock-route and USED_PATHS derivation. It is
  // Contents-gated in reality, but that requirement stays OUT of the
  // section's grant prose because the probe is optional (a token without
  // Contents just skips the advisory branch-does-not-exist wording).
  branchProbe: {
    route: "GET /repos/{owner}/{repo}/branches/{branch}",
    statuses: { 200: "the branch exists", 404: "no such branch" },
    permission: { repo: ["contents"] },
    advisory: true,
  },
  // GitHub App bypass actors resolve by slug through this PUBLIC endpoint:
  // the GraphQL schema offers no app-by-slug lookup (marketplaceListing
  // covers only listed Apps). CAVEAT, documented rather than hidden: for
  // Apps created before GitHub's global-id migration the REST node_id may
  // still be the legacy format, which the mutation accepts with a
  // deprecation warning in the response extensions; user and team ids
  // resolve through GraphQL and are always new-format.
  appLookup: {
    route: "GET /apps/{app_slug}",
    statuses: { 200: "the GitHub App", 404: "no App with this slug" },
    permission: "none",
  },
} as const satisfies Record<string, EndpointDecl>;

// --- GraphQL operations -------------------------------------------------------

/**
 * The one rules read: every classic rule (literal and wildcard patterns
 * alike - classic protection IS a BranchProtectionRule upstream), selecting
 * the node id, every translation-table twin, and the force-push allowance
 * actors. Fired only when an entry has a wildcard name or declares a
 * GraphQL-routed key. NOT_FOUND is a tolerated outcome so a fine-grained
 * denial reads as "no rules visible", preserving the section's
 * denial-surfaces-at-the-first-write semantics.
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

/** The repository's GraphQL node id, needed only to CREATE a wildcard rule. */
const REPO_LOOKUP = graphqlOp<{ owner: string; repo: string }>()({
  name: "BranchProtectionRepository",
  kind: "read",
  outcomes: { ok: "the repository's GraphQL node id" },
  query: `query BranchProtectionRepository($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) { id }
}`,
});

/**
 * A user actor's NEW-format node id. REST /users/{username} can still carry
 * a legacy node_id for old accounts (the mutation would answer a deprecation
 * warning), so users resolve through GraphQL. The repository selection also
 * routes the read (every repo-addressed read takes $owner/$repo).
 */
const ACTOR_USER = graphqlOp<{ owner: string; repo: string; login: string }>()({
  name: "BranchProtectionActorUser",
  kind: "read",
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

/** A team actor's node id, addressed as organization login plus team slug. */
const ACTOR_TEAM = graphqlOp<{ owner: string; repo: string; org: string; team: string }>()({
  name: "BranchProtectionActorTeam",
  kind: "read",
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
 * The three rule mutations. Each payload re-reads the persisted rule, so
 * selecting requiredDeploymentEnvironments IS the post-mutation read-back
 * the silent-drop check needs (GitHub drops names of environments that do
 * not exist without failing the mutation).
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

const GRAPHQL = {
  rulesQuery: RULES_QUERY,
  repoLookup: REPO_LOOKUP,
  actorUser: ACTOR_USER,
  actorTeam: ACTOR_TEAM,
  createRule: CREATE_RULE,
  updateRule: UPDATE_RULE,
  deleteRule: DELETE_RULE,
} as const satisfies Record<string, GraphqlOpDecl>;

/** True when the entry declares a key that must ride the rule mutation. */
function hasRoutedGraphqlKeys(protection: BranchProtectionConfig | null): boolean {
  return (
    protection !== null &&
    (protection.force_push_bypassers !== undefined || protection.required_deployments !== undefined)
  );
}

/** One live rule node as the rules query returns it. */
type RuleNode = Record<string, unknown>;

/** Per-run GraphQL working state: the rules by pattern, and the two caches. */
interface GraphqlRun {
  byPattern: Map<string, RuleNode>;
  repoId: string | null;
  actorIds: Map<string, string>;
}

/**
 * One declared entry paired with its GraphQL proof at classification time: a
 * wildcard entry always carries the run state (its whole reconciliation is
 * the GraphQL surface), a literal entry carries it exactly when it declares
 * a routed key. The tag is built in the ONE place that decides whether the
 * run state exists, so an entry that needs GraphQL without the state being
 * constructed is unrepresentable - no cast, no predicate re-spelling.
 */
type ClassifiedEntry =
  | { kind: "wildcard"; branch: BranchConfig; run: GraphqlRun }
  | { kind: "literal"; branch: BranchConfig; routed: { run: GraphqlRun } | null };

async function fetchRules(
  ctx: SectionContext,
  section: SectionMeta,
): Promise<Map<string, RuleNode>> {
  const read = await listGraphqlConnection(ctx, section, RULES_QUERY, repoVariables(ctx));
  const byPattern = new Map<string, RuleNode>();
  if ("error" in read) {
    // The one tolerated outcome is the declared NOT_FOUND: a fine-grained
    // denial reads as "no rules visible" (the probeAbsent posture), keeping
    // the section's denial-surfaces-at-the-first-write semantics.
    return byPattern;
  }
  for (const node of read.items) {
    if (typeof node === "object" && node !== null) {
      const rule = node as RuleNode;
      // The nested allowance connection is read in one 100-node page; a rule
      // beyond that would silently truncate, so check would report phantom
      // drift and apply would shrink the live list. Fail loudly instead.
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

/** The live allowance actors of a rule, flattened back to the declared strings. */
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
 * Project a live rule node back into the classic snake_case vocabulary, the
 * inverse of translateWildcardProtection: check mode diffs declared keys
 * against this view, and the e2e state test proves the mock's projection of
 * REST state round-trips through it. The two structured keys collapse to
 * null when their umbrella boolean is off - the declared PUT vocabulary's
 * spelling of "off". The real REST GET OMITS an off control entirely
 * (probe-verified on a GraphQL-created minimal rule) rather than nulling
 * it; subsetDiff reads null, absent, and "" as the same empty value, so
 * the two spellings compare identically and null is kept here for the
 * clearer drift message.
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

/**
 * Translate a wildcard entry's classic protection into the rule mutation's
 * input fields (minus the two routed keys, which the caller resolves). Shape
 * validation already restricted the keys, so an unknown key here is a bug.
 */
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

/** The two mutation input fields the required_deployments key declares. */
function deploymentInputFields(
  declared: NonNullable<BranchProtectionConfig["required_deployments"]> | null,
): Record<string, unknown> {
  if (declared === null) {
    return { requiresDeployments: false, requiredDeploymentEnvironments: [] };
  }
  return { requiresDeployments: true, requiredDeploymentEnvironments: [...declared.environments] };
}

/**
 * Case-insensitive set equality for the two routed-key lists: GitHub
 * canonicalizes actor and environment names, so a declared "Octocat" reads
 * back as "octocat" and must not drift. Duplicates are rejected upfront by
 * the shape, so sorted-lowercase comparison is exact.
 */
function sameNamesFold(declared: readonly string[], live: readonly string[]): boolean {
  if (declared.length !== live.length) {
    return false;
  }
  const a = declared.map((name) => name.toLowerCase()).sort();
  const b = live.map((name) => name.toLowerCase()).sort();
  return a.every((name, i) => name === b[i]);
}

/**
 * The silent-drop check and its siblings: GitHub accepts
 * requiredDeploymentEnvironments names of environments that do not exist and
 * DROPS them without failing the mutation (verified live), so the mutation
 * payload's re-read is compared against the declaration - a dropped name
 * fails the run loudly with the fix, and any other divergence (the re-read
 * is authoritative) fails with its own message rather than reporting the
 * apply as converged. Names compare case-insensitively (GitHub environment
 * names are). The environments section runs before this one, so environments
 * declared in the same settings file exist by the time this check runs.
 */
function verifyDeploymentReadback(
  entryName: string,
  declared: BranchProtectionConfig["required_deployments"],
  mutationData: Record<string, unknown>,
  payloadKey: "createBranchProtectionRule" | "updateBranchProtectionRule",
): void {
  if (declared === undefined) {
    return;
  }
  const rule = (mutationData[payloadKey] as Record<string, unknown> | undefined)
    ?.branchProtectionRule as RuleNode | null | undefined;
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
      `branches[${entryName}].protection.required_deployments: GitHub silently dropped [${dropped.join(
        ", ",
      )}] from the required deployment environments because no environment with that name exists on the repository. Declare the environment in this settings file's environments: section (it applies before branches), or create it on the repository first`,
    );
  }
  if (rule.requiresDeployments !== true || !sameNamesFold(declared.environments, echoed)) {
    throw new Error(
      `branches[${entryName}].protection.required_deployments: the settings file requires deployments to [${declared.environments.join(
        ", ",
      )}] but after the mutation the rule ${rule.requiresDeployments === true ? `requires [${echoed.join(", ")}]` : "does not require deployments"}; re-run the workflow, and report this if it persists`,
    );
  }
}

/** Drift lines for the two GraphQL-routed keys, shared by both entry kinds. */
function routedKeyDrift(
  prefix: string,
  protection: BranchProtectionConfig,
  node: RuleNode | undefined,
): string[] {
  const drift: string[] = [];
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
 * Resolve one declared actor string to its GraphQL node id, cached per run
 * under the case-folded string (GitHub canonicalizes actor names, so two
 * spellings are one actor): users and teams through GraphQL (new-format
 * ids), Apps through the public REST lookup (see the appLookup declaration
 * for the legacy-id caveat). The GraphQL reads also select the repository's
 * node id - required anyway to route a repo-addressed read - so a later
 * rule CREATE can reuse it instead of a dedicated lookup.
 */
async function resolveActorId(
  ctx: SectionContext,
  section: SectionMeta,
  run: GraphqlRun,
  raw: string,
): Promise<string> {
  const cacheKey = raw.toLowerCase();
  const cached = run.actorIds.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const actor = parseBypassActor(raw);
  if (actor === null) {
    throw new Error(`BUG: force_push_bypassers actor "${raw}" escaped shape validation`);
  }
  let id: unknown;
  if (actor.kind === "user") {
    const data = await callGraphql(
      ctx,
      section,
      ACTOR_USER,
      { ...repoVariables(ctx), login: actor.login },
      { describe: `resolving force-push bypass user "${raw}"` },
    );
    adoptRepoId(run, data);
    id = (data.user as Record<string, unknown> | null)?.id;
  } else if (actor.kind === "team") {
    const data = await callGraphql(
      ctx,
      section,
      ACTOR_TEAM,
      { ...repoVariables(ctx), org: actor.org, team: actor.team },
      { describe: `resolving force-push bypass team "${raw}"` },
    );
    adoptRepoId(run, data);
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
    const result = await tryCall(ctx, section, ENDPOINTS.appLookup, {
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
  run.actorIds.set(cacheKey, id);
  return id;
}

/** Keep the repository node id an actor read already carried. */
function adoptRepoId(run: GraphqlRun, data: Record<string, unknown>): void {
  const id = (data.repository as Record<string, unknown> | null)?.id;
  if (run.repoId === null && typeof id === "string" && id.length > 0) {
    run.repoId = id;
  }
}

/**
 * The rule node whose pattern is `pattern`, refetching the rules once on a
 * miss: a literal branch the REST PUT just protected has a rule node the
 * pre-mutation fetch could not have seen.
 */
async function ruleNodeFor(
  ctx: SectionContext,
  section: SectionMeta,
  run: GraphqlRun,
  pattern: string,
): Promise<RuleNode> {
  let node = run.byPattern.get(pattern);
  if (node === undefined) {
    run.byPattern = await fetchRules(ctx, section);
    node = run.byPattern.get(pattern);
  }
  if (node === undefined) {
    throw new Error(
      `branches[${pattern}]: the protection was applied but no branch protection rule with that pattern came back from GitHub, so its GraphQL-only fields cannot be set; re-run the workflow, and report this if it persists`,
    );
  }
  return node;
}

/**
 * Resolve a declared actor list to node ids IN DECLARED ORDER, one lookup at
 * a time (the request log stays deterministic), through the per-run cache.
 */
async function resolveActorIds(
  ctx: SectionContext,
  section: SectionMeta,
  run: GraphqlRun,
  actors: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const actor of actors) {
    ids.push(await resolveActorId(ctx, section, run, actor));
  }
  return ids;
}

/** The mutation input fields for a wildcard entry, routed keys resolved. */
async function wildcardInputFields(
  ctx: SectionContext,
  section: SectionMeta,
  run: GraphqlRun,
  protection: BranchProtectionConfig,
): Promise<Record<string, unknown>> {
  const input = translateWildcardProtection(protection);
  if (protection.force_push_bypassers !== undefined) {
    input.bypassForcePushActorIds = await resolveActorIds(
      ctx,
      section,
      run,
      protection.force_push_bypassers,
    );
  }
  if (protection.required_deployments !== undefined) {
    Object.assign(input, deploymentInputFields(protection.required_deployments));
  }
  return input;
}

const WILDCARD_KEY_ERROR = (name: string, key: string): string =>
  `the wildcard entry "${name}" declares protection.${key}, which this section does not manage on wildcard rules; only the keys it can round-trip through the GraphQL rule mutations apply here: [${WILDCARD_KEYS.join(
    ", ",
  )}]. For actor lists and richer controls, prefer the rulesets section (the modern successor of classic protection)`;

export const branchesSection = {
  key: "branches",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  graphql: GRAPHQL,
  // The wildcard-entry key sweep composes onto the schema-derived shape HERE,
  // not in schema.ts: it reads the GraphQL translation tables (WILDCARD_KEYS,
  // the structured twins), which are this section's own machinery. Wildcard
  // entries reject every key outside those tables, since nothing else can
  // reach a wildcard rule.
  shape: loosen(SettingsFile.shape.branches).superRefine((declared, refineCtx) => {
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
      // The structured pairs translate NAMED sub-keys only, so an unknown
      // sub-key on a wildcard entry would be silently lost - reject it with
      // the same pointer. A non-object value (a scalar or an array, both of
      // which the classic REST endpoint would reject server-side) is
      // rejected here too: nothing downstream could translate it.
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
            message: `the wildcard entry "${entry.name}" declares protection.${key} as ${Array.isArray(value) ? "a list" : JSON.stringify(value)}, but on a wildcard rule it must be a mapping of its sub-keys [${Object.keys(twins).join(", ")}], or null to turn the control off`,
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
  async run(ctx, desired): Promise<SectionResult> {
    const result = beginRun(ctx).result;
    // Protection is keyed by exact branch name or pattern; two entries for
    // the same one would overwrite each other's write on every run.
    rejectDuplicates(
      this,
      desired,
      (b) => b.name,
      (b) => b.name,
    );
    // The one rules read, fired only when an entry needs the GraphQL
    // surface: a pure-REST declaration issues no GraphQL request at all.
    // The SAME predicate that gates the fetch classifies the entries, so
    // every entry that needs the run state gets it attached right here.
    const needsGraphql = (branch: BranchConfig): boolean =>
      isWildcardPattern(branch.name) || hasRoutedGraphqlKeys(branch.protection);
    let entries: ClassifiedEntry[];
    if (desired.some(needsGraphql)) {
      const run: GraphqlRun = {
        byPattern: await fetchRules(ctx, this),
        repoId: null,
        actorIds: new Map(),
      };
      const declaredPatterns = new Set(desired.map((branch) => branch.name));
      for (const pattern of [...run.byPattern.keys()].sort()) {
        if (isWildcardPattern(pattern) && !declaredPatterns.has(pattern)) {
          result.notes.push(
            `undeclared classic protection rule "${pattern}" exists on the repo - declare it to manage it (this action never deletes undeclared rules)`,
          );
        }
      }
      entries = desired.map((branch) =>
        isWildcardPattern(branch.name)
          ? { kind: "wildcard", branch, run }
          : {
              kind: "literal",
              branch,
              routed: hasRoutedGraphqlKeys(branch.protection) ? { run } : null,
            },
      );
    } else {
      // No entry satisfies the predicate, so every entry is a plain literal.
      entries = desired.map((branch) => ({ kind: "literal", branch, routed: null }));
    }
    for (const entry of entries) {
      if (entry.kind === "wildcard") {
        await runWildcardEntry(ctx, this, entry.run, entry.branch, result);
        continue;
      }
      await runLiteralEntry(ctx, this, entry.routed, entry.branch, result);
    }
    return result;
  },
} satisfies SectionModule<"branches">;

/**
 * Reconcile one literal-branch entry (the REST path plus routed keys).
 * `routed` is the classification-time proof: non-null exactly when the entry
 * declares a GraphQL-routed key, carrying the per-run GraphQL state.
 */
async function runLiteralEntry(
  ctx: SectionContext,
  section: SectionModule<"branches">,
  routed: { run: GraphqlRun } | null,
  branch: BranchConfig,
  result: SectionResult,
): Promise<void> {
  if (branch.protection === null) {
    const probe = await probeAbsent(ctx, section, ENDPOINTS.getProtection, {
      params: { branch: branch.name },
    });
    if ("missing" in probe) {
      return;
    }
    if (result.check) {
      result.drift.push(
        `branches[${branch.name}]: protected live but the settings file declares protection: null; apply will remove the protection`,
      );
    } else {
      await call(ctx, section, ENDPOINTS.removeProtection, { params: { branch: branch.name } });
      result.changes.push(`removed protection from "${branch.name}"`);
    }
    return;
  }
  // The routed keys never ride the REST payload: GitHub's protection PUT
  // silently DROPS required_signatures (its sub-endpoint applies it), and
  // force_push_bypassers/required_deployments have no REST field at all
  // (one rule mutation applies both).
  const {
    required_signatures: requiredSignatures,
    force_push_bypassers: forcePushBypassers,
    required_deployments: requiredDeployments,
    ...payload
  } = branch.protection;
  // The classic API rejects payloads missing the core keys; fill nulls.
  for (const key of REQUIRED_PROTECTION_KEYS) {
    if (!(key in payload)) {
      payload[key] = null;
    }
  }
  if (result.check) {
    const probe = await probeAbsent(ctx, section, ENDPOINTS.getProtection, {
      params: { branch: branch.name },
    });
    if ("missing" in probe) {
      // Protection 404s for a missing BRANCH too. The branch probe is
      // advisory: only a definitive 404 flips the message (other errors,
      // e.g. a token without Contents read, fall back to the plain
      // unprotected reading rather than misreporting or failing).
      const branchProbe = await ctx.api.tryRequest(
        "GET",
        expand(ENDPOINTS.branchProbe, ctx, { branch: branch.name }),
      );
      if ("error" in branchProbe && branchProbe.error.status === 404) {
        result.drift.push(
          `branches[${branch.name}]: declared in the settings file but the branch does not exist on the repo, so apply cannot protect it; create the branch, or remove it from the settings file`,
        );
      } else {
        result.drift.push(
          `branches[${branch.name}]: unprotected live but the settings file declares protection; apply will protect it`,
        );
      }
    } else {
      // GET shapes booleans as {enabled: bool}; compare declared keys
      // against a flattened view. The routed keys were destructured off the
      // payload above; required_signatures is the one with a REST read to
      // diff against, the other two diff against the GraphQL rule below.
      const live = flattenProtection(probe.data as Record<string, unknown>);
      // The protection GET OMITS required_signatures entirely when
      // signed commits are not required, so an absent live field means
      // false; normalize before the diff so declared false does not
      // read as drift.
      if (!("required_signatures" in live)) {
        live.required_signatures = false;
      }
      const declaredRest: Record<string, unknown> = { ...payload };
      for (const key of REQUIRED_PROTECTION_KEYS) {
        if (!(key in branch.protection)) {
          delete declaredRest[key];
        }
      }
      if (requiredSignatures !== undefined) {
        declaredRest.required_signatures = requiredSignatures;
      }
      result.drift.push(...subsetDiff(declaredRest, live, `branches[${branch.name}].protection`));
      result.drift.push(
        ...routedKeyDrift(
          `branches[${branch.name}].protection`,
          branch.protection,
          routed?.run.byPattern.get(branch.name),
        ),
      );
      // Apply null-fills the four required keys, REMOVING live settings
      // the declaration omits - surface that as drift, not silence.
      for (const key of REQUIRED_PROTECTION_KEYS) {
        if (!(key in branch.protection) && live[key] != null && live[key] !== false) {
          result.drift.push(
            `branches[${branch.name}].protection.${key}: set live but omitted from the settings file, so apply would REMOVE it; add ${key} to the branch's protection in the settings file to keep it`,
          );
        }
      }
    }
    return;
  }
  // Actor resolution comes BEFORE the destructive PUT: a misspelled actor
  // must fail the entry while the live protection is still untouched, not
  // after the PUT already replaced it. Resolution is read-only.
  // (forcePushBypassers implies routed; the conjunct carries that fact to
  // the type checker.)
  const resolvedBypassIds =
    routed !== null && forcePushBypassers !== undefined
      ? await resolveActorIds(ctx, section, routed.run, forcePushBypassers)
      : undefined;
  await call(ctx, section, ENDPOINTS.putProtection, {
    params: { branch: branch.name },
    payload,
    describe: `replacing protection for branch "${branch.name}"`,
  });
  // The declared toggle is applied once the PUT has ensured the
  // protection (and with it the sub-resource) exists; an undeclared
  // toggle leaves the live requirement alone.
  if (requiredSignatures === true) {
    await call(ctx, section, ENDPOINTS.sigPost, {
      params: { branch: branch.name },
      describe: `requiring signed commits on branch "${branch.name}"`,
    });
  } else if (requiredSignatures === false) {
    await call(ctx, section, ENDPOINTS.sigDelete, {
      params: { branch: branch.name },
      describe: `removing the signed-commit requirement from branch "${branch.name}"`,
    });
  }
  if (routed !== null) {
    // The entry declared a routed key, so the classification attached the
    // run state; the rule node itself may be fresh (the PUT above just
    // created it), which the one-refetch lookup covers.
    const node = await ruleNodeFor(ctx, section, routed.run, branch.name);
    const input: Record<string, unknown> = { branchProtectionRuleId: node.id };
    if (resolvedBypassIds !== undefined) {
      input.bypassForcePushActorIds = resolvedBypassIds;
    }
    if (requiredDeployments !== undefined) {
      Object.assign(input, deploymentInputFields(requiredDeployments));
    }
    const data = await callGraphql(
      ctx,
      section,
      UPDATE_RULE,
      { input },
      { describe: `setting the GraphQL-only protection fields of branch "${branch.name}"` },
    );
    verifyDeploymentReadback(branch.name, requiredDeployments, data, "updateBranchProtectionRule");
  }
  result.changes.push(`applied protection to "${branch.name}"`);
}

/** Reconcile one wildcard entry, entirely through the GraphQL rule surface. */
async function runWildcardEntry(
  ctx: SectionContext,
  section: SectionModule<"branches">,
  run: GraphqlRun,
  branch: BranchConfig,
  result: SectionResult,
): Promise<void> {
  const pattern = branch.name;
  const node = run.byPattern.get(pattern);
  if (branch.protection === null) {
    if (node === undefined) {
      return;
    }
    if (result.check) {
      result.drift.push(
        `branches[${pattern}]: a live rule matches this pattern but the settings file declares protection: null; apply will delete the rule`,
      );
      return;
    }
    await callGraphql(
      ctx,
      section,
      DELETE_RULE,
      { input: { branchProtectionRuleId: node.id } },
      { describe: `deleting the protection rule "${pattern}"` },
    );
    run.byPattern.delete(pattern);
    result.changes.push(`deleted protection rule "${pattern}"`);
    return;
  }
  if (result.check) {
    if (node === undefined) {
      result.drift.push(
        `branches[${pattern}]: no live rule matches this pattern but the settings file declares protection; apply will create the rule`,
      );
      return;
    }
    const declared: Record<string, unknown> = { ...branch.protection };
    delete declared.force_push_bypassers;
    delete declared.required_deployments;
    result.drift.push(
      ...subsetDiff(declared, classicViewOfRule(node), `branches[${pattern}].protection`),
    );
    result.drift.push(
      ...routedKeyDrift(`branches[${pattern}].protection`, branch.protection, node),
    );
    return;
  }
  const fields = await wildcardInputFields(ctx, section, run, branch.protection);
  if (node !== undefined) {
    const data = await callGraphql(
      ctx,
      section,
      UPDATE_RULE,
      { input: { branchProtectionRuleId: node.id, ...fields } },
      { describe: `updating the protection rule "${pattern}"` },
    );
    verifyDeploymentReadback(
      pattern,
      branch.protection.required_deployments,
      data,
      "updateBranchProtectionRule",
    );
    result.changes.push(`updated protection rule "${pattern}"`);
    return;
  }
  if (run.repoId === null) {
    const data = await callGraphql(ctx, section, REPO_LOOKUP, repoVariables(ctx), {
      describe: "resolving the repository's GraphQL node id",
    });
    const id = (data.repository as Record<string, unknown> | null)?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        "branches: the repository lookup returned no GraphQL node id, so no protection rule can be created; re-run the workflow, and retry later if it persists",
      );
    }
    run.repoId = id;
  }
  const data = await callGraphql(
    ctx,
    section,
    CREATE_RULE,
    { input: { repositoryId: run.repoId, pattern, ...fields } },
    { describe: `creating the protection rule "${pattern}"` },
  );
  verifyDeploymentReadback(
    pattern,
    branch.protection.required_deployments,
    data,
    "createBranchProtectionRule",
  );
  // The mutation payload's rule is NOT cached into run.byPattern: it carries
  // only the read-back fields, not a full rules-query node, and duplicate
  // rejection means no later entry can look this pattern up anyway.
  result.changes.push(`created protection rule "${pattern}"`);
}

/**
 * GET /protection wraps booleans as {url, enabled} and expands actor lists
 * (restrictions, dismissal_restrictions, bypass_pull_request_allowances)
 * into user/team/app OBJECTS, while the PUT shape uses login/slug strings.
 * Unwrap both so check mode compares like with like. Exported so the e2e
 * state tests assert their protectionFromPut transformer inverts this exact
 * function (not a lookalike copy).
 */
export function flattenProtection(live: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(live)) {
    out[key] = flattenValue(value);
  }
  return out;
}

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
    } else if (key.endsWith("_url") || key === "url") {
      // URLs never appear in the PUT shape; drop to avoid noise.
    } else {
      out[key] = flattenValue(inner);
    }
  }
  return out;
}
