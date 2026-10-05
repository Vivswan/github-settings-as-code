/** index.ts decides which entries reach this module; nothing here classifies entries. */

import { err, ok, type Result, safeTry } from "neverthrow";
import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import { repoVariables } from "../contract/endpoints.js";
import { type SectionFailure, sectionFailure } from "../contract/errors.js";
import type { ChangeLines, ExecTools, Late, Read } from "../contract/plan.js";
import type {
  BranchesContext,
  BranchesPlan,
  GraphqlRun,
  LiveRules,
  RuleNode,
} from "./graphql-ops.js";
import { bypassActorStrings, classicViewOfRule, fetchRules } from "./graphql-reads.js";
import {
  GRAPHQL_BOOLEAN_TWINS,
  GRAPHQL_REVIEW_TWINS,
  GRAPHQL_STATUS_CHECK_TWINS,
  ROUTED_KEY_SET,
  ROUTED_KEYS,
  type RoutedProtection,
} from "./graphql-vocabulary.js";
import { type BranchConfig, type BranchProtectionConfig, parseBypassActor } from "./schema.js";

/** The node id a lookup selects; null when the token cannot see the object. */
const NodeId = z.looseObject({ id: z.string() }).nullable().optional();

const RepositoryLookup = z.looseObject({ repository: NodeId });

const UserLookup = z.looseObject({ repository: NodeId, user: NodeId });

const TeamLookup = z.looseObject({
  repository: NodeId,
  organization: z.looseObject({ team: NodeId }).nullable().optional(),
});

const AppLookup = z.looseObject({ node_id: z.string().optional() });

/** Shape validation already restricted a wildcard entry's keys, so an unknown key here is a bug. */
function translateWildcardProtection(protection: BranchProtectionConfig): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(protection)) {
    if (ROUTED_KEY_SET.has(key)) {
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
): Result<void, SectionFailure> {
  const unverified = (message: string): Result<never, SectionFailure> =>
    err(sectionFailure("unverified", message));
  const payload = (response as Record<string, unknown> | null)?.[payloadKey];
  const rule = (payload as Record<string, unknown> | null | undefined)?.branchProtectionRule as
    | RuleNode
    | null
    | undefined;
  if (typeof rule !== "object" || rule === null) {
    return unverified(
      `branches[${entryName}].protection.required_deployments: the mutation returned no rule to read back, so the applied deployment requirement cannot be verified; re-run the workflow, and retry later if it persists`,
    );
  }
  const echoed = Array.isArray(rule.requiredDeploymentEnvironments)
    ? (rule.requiredDeploymentEnvironments as unknown[]).map(String)
    : [];
  if (declared === null) {
    if (rule.requiresDeployments === true) {
      return unverified(
        `branches[${entryName}].protection.required_deployments: declared null (not required) but the rule still requires deployments to [${echoed.join(", ")}] after the mutation; re-run the workflow, and report this if it persists`,
      );
    }
    return ok(undefined);
  }
  const echoedFold = new Set(echoed.map((name) => name.toLowerCase()));
  const dropped = declared.environments.filter((name) => !echoedFold.has(name.toLowerCase()));
  if (dropped.length > 0) {
    return unverified(
      `branches[${entryName}].protection.required_deployments: GitHub silently dropped [${dropped.join(", ")}] ` +
        "from the required deployment environments because no environment with that name exists on the repository. " +
        "Declare the environment in this settings file's environments: section (it applies before branches), " +
        "or create it on the repository first",
    );
  }
  if (rule.requiresDeployments !== true || !sameNamesFold(declared.environments, echoed)) {
    return unverified(
      `branches[${entryName}].protection.required_deployments: the settings file requires deployments to ` +
        `[${declared.environments.join(", ")}] but after the mutation the rule ` +
        `${rule.requiresDeployments === true ? `requires [${echoed.join(", ")}]` : "does not require deployments"}; ` +
        "re-run the workflow, and report this if it persists",
    );
  }
  return ok(undefined);
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
    for (const key of ROUTED_KEYS) {
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
): Promise<Result<string, SectionFailure>> {
  const cacheKey = raw.toLowerCase();
  const cached = graphqlRun.actorIds.get(cacheKey);
  if (cached !== undefined) {
    return ok(cached);
  }
  const actor = parseBypassActor(raw);
  if (actor === null) {
    throw new Error(`BUG: force_push_bypassers actor "${raw}" escaped shape validation`);
  }
  return safeTry(async function* () {
    let id: string | undefined;
    if (actor.kind === "user") {
      const data = yield* ctx.read.actorUser.call(
        exec,
        UserLookup,
        { ...repoVariables(ctx), login: actor.login },
        { describe: `resolving force-push bypass user "${raw}"` },
      );
      adoptRepoId(graphqlRun, data);
      id = data.user?.id;
    } else if (actor.kind === "team") {
      const data = yield* ctx.read.actorTeam.call(
        exec,
        TeamLookup,
        { ...repoVariables(ctx), org: actor.org, team: actor.team },
        { describe: `resolving force-push bypass team "${raw}"` },
      );
      adoptRepoId(graphqlRun, data);
      const team = data.organization?.team;
      if (team === null || team === undefined) {
        return err(
          sectionFailure(
            "refused",
            `branches: force_push_bypassers actor "${raw}": the organization "${actor.org}" has no team with slug "${actor.team}" (or the token cannot see it); check the actor spelling in the settings file`,
          ),
        );
      }
      id = team.id;
    } else {
      const result = yield* ctx.read.appLookup.tryCall(exec, AppLookup, {
        params: { app_slug: actor.slug },
        describe: `resolving force-push bypass App "${raw}"`,
      });
      if ("error" in result) {
        return err(
          sectionFailure(
            "refused",
            `branches: force_push_bypassers actor "${raw}": no GitHub App with slug "${actor.slug}" exists; check the actor spelling in the settings file`,
          ),
        );
      }
      id = result.data.node_id;
    }
    if (id === undefined || id.length === 0) {
      return err(
        sectionFailure(
          "live-shape",
          `branches: force_push_bypassers actor "${raw}": the ${actor.kind === "app" ? "App lookup" : "GraphQL lookup"} succeeded but returned no node id, so the allowance cannot be applied; re-run the workflow, and report this if it persists`,
        ),
      );
    }
    graphqlRun.actorIds.set(cacheKey, id);
    return ok(id);
  });
}

function adoptRepoId(graphqlRun: GraphqlRun, data: z.infer<typeof RepositoryLookup>): void {
  const id = data.repository?.id;
  if (graphqlRun.repoId === null && id !== undefined && id.length > 0) {
    graphqlRun.repoId = id;
  }
}

/**
 * Read at EXECUTION time when the plan-time fetch did not carry the rule: a PUT planned earlier may
 * have created it, or the rules query answered its tolerated NOT_FOUND.
 */
function lateRuleId(ctx: BranchesContext, pattern: string): Read<unknown> {
  return fetchRules(ctx).andThen((rules) => {
    const node = rules?.get(pattern);
    if (node === undefined) {
      return err(
        sectionFailure(
          "live-shape",
          `branches[${pattern}]: the branch is protected but no branch protection rule with that ` +
            `pattern is visible through GraphQL, so its GraphQL-only fields cannot be set; check ` +
            `that the token can read branch protection rules, re-run the workflow, and report this ` +
            `if it persists`,
        ),
      );
    }
    return ok(node.id);
  });
}

/** IN DECLARED ORDER, one lookup at a time, so the request log stays deterministic. */
export async function resolveActorIds(
  ctx: BranchesContext,
  exec: ExecTools,
  graphqlRun: GraphqlRun,
  actors: readonly string[],
): Promise<Result<string[], SectionFailure>> {
  return safeTry(async function* () {
    const ids: string[] = [];
    for (const actor of actors) {
      ids.push(yield* await resolveActorId(ctx, exec, graphqlRun, actor));
    }
    return ok(ids);
  });
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
  late?: (exec: ExecTools) => Promise<Result<Record<string, unknown>, SectionFailure>>,
): RuleVariables {
  if (actors === undefined && late === undefined) {
    return { input: fields };
  }
  if (actors !== undefined) {
    graphqlRun.lateActors.push(...actors);
  }
  // The actors resolve first: a user or team read also selects the repository's node id, which
  // spares a create its dedicated lookup (adoptRepoId).
  return async (exec) =>
    safeTry(async function* () {
      const actorIds =
        actors === undefined
          ? {}
          : {
              bypassForcePushActorIds: yield* await resolveActorIds(ctx, exec, graphqlRun, actors),
            };
      const lateFields = late === undefined ? {} : yield* await late(exec);
      return ok({ input: { ...fields, ...actorIds, ...lateFields } });
    });
}

async function repositoryNodeId(
  ctx: BranchesContext,
  exec: ExecTools,
  graphqlRun: GraphqlRun,
): Promise<Result<string, SectionFailure>> {
  if (graphqlRun.repoId !== null) {
    return ok(graphqlRun.repoId);
  }
  return ctx.read.repoLookup
    .call(exec, RepositoryLookup, repoVariables(ctx), {
      describe: "resolving the repository's GraphQL node id",
    })
    .andThen((data) => {
      const id = data.repository?.id;
      if (id === undefined || id.length === 0) {
        return err(
          sectionFailure(
            "live-shape",
            "branches: the repository lookup returned no GraphQL node id, so no protection rule can be created; re-run the workflow and retry if it persists",
          ),
        );
      }
      graphqlRun.repoId = id;
      return ok(id);
    });
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
): string | ((response: unknown) => Result<ChangeLines, SectionFailure>) {
  if (declared === undefined) {
    return line;
  }
  return (response) =>
    verifyDeploymentReadback(entryName, declared, response, payloadKey).map(() => line);
}

export function planRoutedUpdate(
  ctx: BranchesContext,
  graphqlRun: GraphqlRun,
  plan: BranchesPlan,
  entry: {
    name: string;
    protection: RoutedProtection;
    prefix: string;
    putPlanned: boolean;
  },
): void {
  const { name, protection, prefix, putPlanned } = entry;
  const { force_push_bypassers: forcePushBypassers, required_deployments: requiredDeployments } =
    protection;
  const node = graphqlRun.rules?.get(name);
  const routedKeys = ROUTED_KEYS.filter((key) => protection[key] !== undefined).join(" and ");
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
        : ruleVariables(ctx, graphqlRun, deploymentFields, forcePushBypassers, async () =>
            lateRuleId(ctx, name).map((id) => ({ branchProtectionRuleId: id })),
          ),
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
      variables: ruleVariables(ctx, graphqlRun, { pattern, ...fields }, actors, async (exec) =>
        (await repositoryNodeId(ctx, exec, graphqlRun)).map((id) => ({ repositoryId: id })),
      ),
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
  for (const key of ROUTED_KEYS) {
    delete declared[key];
  }
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
