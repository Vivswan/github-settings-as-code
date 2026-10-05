/**
 * Every rules response decodes through RuleNode, so a field a translator reads is declared in the
 * selection and in the shape here first.
 */

import { z } from "zod";
import { type GraphqlOpDecl, graphqlOp } from "../contract/graphql.js";
import type { PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import type { ENDPOINTS } from "./endpoints.js";

/**
 * The rule selection both rules reads share, so the snapshot's read cannot lag the planner's
 * translation tables (test/sections/graphql-queries.test.ts asserts every twin is selected).
 */
const RULES_SELECTION = `($owner: String!, $repo: String!, $cursor: String) {
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
}`;

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
  query: `query BranchProtectionRules${RULES_SELECTION}`,
});

/**
 * The snapshot's read of the same rules. No write follows a snapshot to surface a denial, so
 * NOT_FOUND is not tolerated here: a concealed denial fails the read with the grant advice.
 */
const RULES_SNAPSHOT = graphqlOp<{ owner: string; repo: string }>()({
  name: "BranchProtectionRulesSnapshot",
  kind: "read",
  connection: { path: ["repository", "branchProtectionRules"] },
  outcomes: { ok: "the repository's classic branch protection rules, for the snapshot" },
  query: `query BranchProtectionRulesSnapshot${RULES_SELECTION}`,
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
  rulesSnapshot: RULES_SNAPSHOT,
  repoLookup: REPO_LOOKUP,
  actorUser: ACTOR_USER,
  actorTeam: ACTOR_TEAM,
  createRule: CREATE_RULE,
  updateRule: UPDATE_RULE,
  deleteRule: DELETE_RULE,
} as const satisfies Record<string, GraphqlOpDecl>;

/**
 * A rule node as the selection returns it, every twin the translators read declared with the SDL's
 * nullability, so a value off the vocabulary fails the read instead of vanishing from the classic view.
 */
export const RuleNode = z.looseObject({
  id: z.string(),
  pattern: z.string(),
  isAdminEnforced: z.boolean(),
  requiresLinearHistory: z.boolean(),
  allowsForcePushes: z.boolean(),
  allowsDeletions: z.boolean(),
  blocksCreations: z.boolean(),
  requiresConversationResolution: z.boolean(),
  lockBranch: z.boolean(),
  lockAllowsFetchAndMerge: z.boolean(),
  requiresCommitSignatures: z.boolean(),
  requiresStatusChecks: z.boolean(),
  requiresStrictStatusChecks: z.boolean(),
  requiredStatusCheckContexts: z.array(z.string()).nullable(),
  requiresApprovingReviews: z.boolean(),
  requiredApprovingReviewCount: z.number().nullable(),
  requiresCodeOwnerReviews: z.boolean(),
  dismissesStaleReviews: z.boolean(),
  requireLastPushApproval: z.boolean(),
  requiresDeployments: z.boolean(),
  requiredDeploymentEnvironments: z.array(z.string()).nullable(),
  bypassForcePushAllowances: z.looseObject({
    nodes: z
      .array(
        z
          .looseObject({
            // The selection names one identity per actor variant (User login, Team combinedSlug, App slug).
            actor: z
              .union([
                z.looseObject({ login: z.string() }),
                z.looseObject({ combinedSlug: z.string() }),
                z.looseObject({ slug: z.string() }),
              ])
              .nullable()
              .optional(),
          })
          .nullable(),
      )
      .nullable(),
    pageInfo: z.looseObject({ hasNextPage: z.boolean() }),
  }),
});
export type RuleNode = z.infer<typeof RuleNode>;

/**
 * null when the rules query answered its tolerated NOT_FOUND: unreadable is not the same as empty,
 * so a declared routed key must not read as clean against it.
 */
export type LiveRules = Map<string, RuleNode> | null;

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
