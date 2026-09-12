/**
 * The mock GitHub server's state layer: the sparse per-scenario overlay (LiveState), the materialized
 * working state (MockState), and the pure write-to-read transformers.
 *
 * Each transformer must produce the GET shape whose section read-back converges with the PUT payload, or a
 * check over freshly applied state reports drift; state.test.ts proves each round trip.
 *   protectionFromPut    -> read back by branches' flattenProtection
 *   environmentFromPut   -> read back by environments' flattenEnvironment
 *   collaboratorFromPut  -> role_name via roleForPermission, the same map the section runs on its declaration
 */

import { AUTOLINKS_MOCK } from "../../../src/sections/autolinks/mock.js";
import {
  GRAPHQL_BOOLEAN_TWINS,
  GRAPHQL_REVIEW_TWINS,
  GRAPHQL_STATUS_CHECK_TWINS,
} from "../../../src/sections/branches/graphql-rules.js";
import { parseBypassActor } from "../../../src/sections/branches/schema.js";
import { DEPLOY_KEYS_MOCK } from "../../../src/sections/deploy_keys/mock.js";
import { LABELS_MOCK } from "../../../src/sections/labels/mock.js";
import type { ListSectionKey } from "../../../src/sections/shared/list-section.js";
import { INVITATION_ROLES, roleForPermission } from "../../../src/sections/shared/roles.js";
import type { MustBeNever } from "../../../src/types.js";
import { ADMIN_OWNER } from "../constants.js";
import orgFixture from "../fixtures/org.json" with { type: "json" };
import repoFixture from "../fixtures/repo.json" with { type: "json" };
import type { OwnerKind, PermissionMask } from "../schema.js";
import type { ListMockSpec } from "./list-fragment.js";
import { decodeNodeId, mintNodeId } from "./node-id.js";

type Json = Record<string, unknown>;

interface LabelsGenerate {
  count: number;
  prefix: string;
  color: string;
}

/**
 * A scenario's sparse starting state. A family holds the GET-side body the mock serves, never the
 * section's declared or PUT shape, unless its own comment names a sugar or an internal shape; an absent
 * family starts from its fixture baseline (empty for lists).
 */
export interface LiveState {
  /** Partial repo object merged (deep) over repo.json. */
  repo?: Json;
  /** Replaces the baseline; a seed may be sparse ({name, color}), buildState completes it. */
  labels?: Json[] | { generate: LabelsGenerate };
  /** Repository rulesets (summary + full bodies), replaces the baseline. */
  rulesets?: Json[];
  /** Branch protection keyed by branch name; null means "unprotected". */
  branch_protection?: Record<string, Json | null>;
  /**
   * GraphQL-only fields of LITERAL rules (bypassForcePushActors as actor strings, requiresDeployments,
   * requiredDeploymentEnvironments), keyed by branch: the REST GET shape cannot carry them, so the rules
   * query merges them into the node it projects from branch_protection.
   */
  branch_protection_graphql?: Record<string, Json>;
  /**
   * WILDCARD-pattern classic rules, invisible to every REST protection endpoint like on GitHub and served
   * only by the GraphQL rules query. Seeds use the internal rule shape (GraphQL field names,
   * bypassForcePushActors as actor strings); buildState completes them and stamps their ids.
   */
  branch_protection_rules?: Json[];
  /** Branch names that exist on the repo (drives the advisory branch probe). */
  branches?: string[];
  /** Deployment environments keyed by name (GET shape). */
  environments?: Record<string, Json>;
  /** Per-environment Actions variables (GET shape), keyed by environment name. */
  environment_variables?: Record<string, Json[]>;
  /**
   * Per-environment deployment branch-policy patterns (GET shape {id, name, type}), keyed by environment.
   * Served only while the environment's deployment_branch_policy enables custom_branch_policies; the
   * endpoints 404 otherwise, like GitHub.
   */
  environment_branch_policies?: Record<string, Json[]>;
  /**
   * Per-environment enabled custom deployment protection rules (GET shape), keyed by environment. Seed
   * apps from PROTECTION_RULE_APPS so the available-Apps listing agrees with them.
   */
  environment_protection_rules?: Record<string, Json[]>;
  /**
   * A plain string takes the next contiguous position; the object form seeds an explicit, possibly HOLE-Y
   * position, since live GitHub does not renumber on unpin. Seeded names should exist in `environments`:
   * a pin's target is always a real environment.
   */
  pinned_environments?: Array<string | { name: string; position: number }>;
  /** Autolinks, replaces the baseline; a sparse seed is completed like a label. */
  autolinks?: Json[];
  /** GET /actions/permissions body. */
  actions_permissions?: Json;
  /** GET /actions/permissions/selected-actions body. */
  selected_actions?: Json;
  /** GET /actions/permissions/workflow body. */
  workflow_permissions?: Json;
  /** GET /actions/permissions/access body. */
  actions_access?: Json;
  /** GET /actions/permissions/artifact-and-log-retention body. */
  actions_retention?: Json;
  /** GET /actions/cache/retention-limit body. */
  cache_retention_limit?: Json;
  /** GET /actions/cache/storage-limit body. */
  cache_storage_limit?: Json;
  /** GET /actions/oidc/customization/sub body. */
  oidc_customization_sub?: Json;
  /** GET /actions/permissions/fork-pr-contributor-approval body. */
  fork_pr_contributor_approval?: Json;
  /** GET /actions/permissions/fork-pr-workflows-private-repos body. */
  fork_pr_workflows_private_repos?: Json;
  /**
   * Actions secrets list items (GET shape: {name, created_at, updated_at}). Values are never part of the
   * GET shape; the mock tracks a digest of each uploaded value separately.
   */
  actions_secrets?: Json[];
  /** Dependabot secrets list items, same GET shape as actions_secrets. */
  dependabot_secrets?: Json[];
  /** Codespaces secrets list items, same GET shape as actions_secrets. */
  codespaces_secrets?: Json[];
  /** Copilot agents secrets list items, same GET shape as actions_secrets. */
  agents_secrets?: Json[];
  /** Per-environment Actions secrets, same GET shape as actions_secrets; digests are tracked per environment. */
  environment_secrets?: Record<string, Json[]>;
  /** Workflows list items ({id, name, path, state}), replaces the baseline. */
  workflows?: Json[];
  /** GET /pages body, or null for "Pages not enabled". */
  pages?: Json | null;
  /** GET /code-scanning/default-setup body. */
  code_scanning?: Json;
  /** GET /code-quality/setup body. */
  code_quality?: Json;
  /**
   * Stored check suite preferences ({auto_trigger_checks}): write-only on the real API (no GET exists),
   * the PATCH echoes them under a `preferences` wrapper.
   */
  check_suite_preferences?: Json;
  /** Direct collaborators (GET shape with role_name), replaces the baseline. */
  collaborators?: Json[];
  /**
   * Pending repository invitations; typically only {invitee: {login}, permissions, expired} is seeded and
   * buildState completes the rest of the spec's required shape.
   */
  invitations?: Json[];
  /** Team access keyed by team slug; null means "no access". */
  teams?: Record<string, { role_name: string } | null>;
  /** Milestones (GET shape), replaces the baseline. */
  milestones?: Json[];
  /** GET /interaction-limits body ({limit, origin, expires_at}); default none. */
  interaction_limits?: Json;
  /**
   * GET /interaction-limits/pulls/creation-cap body; the spec requires both fields in every response, so
   * the default is an unconfigured repo's disabled cap.
   */
  pull_creation_cap?: Json;
  /** When true, both creation-cap endpoints answer GitHub's documented 405 (the cap is not available here). */
  pull_creation_cap_unavailable?: boolean;
  /**
   * The creation-cap bypass list (simple-user GET shape); a seed may be just a login, buildState completes
   * it via bypassUser, the same completion the PUT handler applies.
   */
  pull_bypass_list?: Json[];
  /** Actions repository variables (GET shape); GitHub stores names uppercased, so seed uppercase names. */
  actions_variables?: Json[];
  /** Copilot agents repository variables, same GET shape and uppercase-name rule as actions_variables. */
  agents_variables?: Json[];
  /** When true, an org- or user-level limit is in effect: repo-level PUT/DELETE answer 409, matching GitHub. */
  interaction_limits_org_override?: boolean;
  /**
   * Repository webhooks; a sparse seed is completed to the spec's shape by completeHook. A seeded
   * config.secret is STORED verbatim but every GET echoes it as "********", matching GitHub.
   */
  hooks?: Json[];
  /**
   * Deploy keys (GET shape), replaces the (empty) baseline; a sparse seed is completed like a label,
   * its key material stored comment-free the way GitHub normalizes a created key.
   */
  deploy_keys?: Json[];
  /**
   * Issues the repo already has; the private-report issue channel lists, creates, and patches these, so
   * a seeded report issue exercises the update-in-place path.
   */
  issues?: Json[];
  /**
   * Custom property values ({property_name, value}); seed names from CUSTOM_PROPERTY_DEFINITIONS so the
   * PATCH handler's defined-property check agrees with them.
   */
  custom_property_values?: Json[];
  /** Secret scanning custom patterns in GET shape. */
  secret_scanning_patterns?: Json[];
}

/**
 * The runtime enum the scenario schema keys `live_state` off (test/e2e/schema.ts), so a typo'd family
 * fails scenario LOAD instead of being accepted and silently unseeded. The `satisfies` and the
 * MustBeNever pin keep it in lockstep with the interface in both directions.
 */
export const LIVE_STATE_KEYS = [
  "repo",
  "labels",
  "rulesets",
  "branch_protection",
  "branch_protection_graphql",
  "branch_protection_rules",
  "branches",
  "environments",
  "environment_variables",
  "environment_branch_policies",
  "environment_protection_rules",
  "pinned_environments",
  "autolinks",
  "actions_permissions",
  "selected_actions",
  "workflow_permissions",
  "actions_access",
  "actions_retention",
  "cache_retention_limit",
  "cache_storage_limit",
  "oidc_customization_sub",
  "fork_pr_contributor_approval",
  "fork_pr_workflows_private_repos",
  "actions_secrets",
  "dependabot_secrets",
  "codespaces_secrets",
  "agents_secrets",
  "environment_secrets",
  "workflows",
  "pages",
  "code_scanning",
  "code_quality",
  "check_suite_preferences",
  "collaborators",
  "invitations",
  "teams",
  "milestones",
  "interaction_limits",
  "pull_creation_cap",
  "pull_creation_cap_unavailable",
  "pull_bypass_list",
  "actions_variables",
  "agents_variables",
  "interaction_limits_org_override",
  "hooks",
  "deploy_keys",
  "issues",
  "custom_property_values",
  "secret_scanning_patterns",
] as const satisfies readonly (keyof LiveState)[];
type _LiveStateKeysComplete = MustBeNever<
  Exclude<keyof LiveState, (typeof LIVE_STATE_KEYS)[number]>
>;

export interface MockState {
  /**
   * The "owner/name" identity node ids and per-slug routing key off, fixed at construction. Never read it
   * off the repo body: a PATCH that writes `full_name` must not move the identity minted ids carry.
   */
  readonly slug: string;
  ownerKind: OwnerKind;
  /** The org body, or null when the owner is a personal account. */
  org: Json | null;
  repo: Json;
  labels: Json[];
  rulesets: Json[];
  branch_protection: Record<string, Json | null>;
  /** GraphQL-only fields of literal rules, keyed by branch name. */
  branch_protection_graphql: Record<string, Json>;
  /** Wildcard classic rules in the internal rule shape (see LiveState). */
  branch_protection_rules: Json[];
  branches: string[];
  environments: Record<string, Json>;
  environment_variables: Record<string, Json[]>;
  environment_branch_policies: Record<string, Json[]>;
  environment_protection_rules: Record<string, Json[]>;
  /**
   * Pins in rank order; positions mirror verified GitHub behavior.
   *   new pin  -> _pinned_position_counter + 1 (monotonic)
   *   unpin    -> leaves a HOLE, no renumbering
   *   reorder  -> the only path that renormalizes to contiguous 1..N
   */
  pinned_environments: Array<{ name: string; position: number }>;
  /**
   * Starts at the seeded maximum. Underscore prefix: mock bookkeeping, excluded from the idempotence
   * snapshot (snapshotFamilies in apply-idempotence-proof.ts).
   */
  _pinned_position_counter: number;
  autolinks: Json[];
  actions_permissions: Json;
  selected_actions: Json;
  workflow_permissions: Json;
  actions_access: Json;
  actions_retention: Json;
  cache_retention_limit: Json;
  cache_storage_limit: Json;
  oidc_customization_sub: Json;
  fork_pr_contributor_approval: Json;
  fork_pr_workflows_private_repos: Json;
  /** Actions secrets in GET shape ({name, created_at, updated_at}). */
  actions_secrets: Json[];
  /** Dependabot secrets, same GET shape as actions_secrets. */
  dependabot_secrets: Json[];
  /** Codespaces secrets, same GET shape as actions_secrets. */
  codespaces_secrets: Json[];
  /** Copilot agents secrets, same GET shape as actions_secrets. */
  agents_secrets: Json[];
  /** Per-environment Actions secrets (GET shape), keyed by environment name. */
  environment_secrets: Record<string, Json[]>;
  /**
   * Shared by EVERY secret family, feeding each write's deterministic updated_at. Underscore prefix: mock
   * bookkeeping, excluded from the idempotence snapshot (snapshotFamilies in apply-idempotence-proof.ts).
   */
  _secret_write_counter: number;
  /**
   * sha256 of each uploaded secret's UNSEALED value, never the plaintext and never served: a re-seal
   * produces different ciphertext for the same plaintext, so only a plaintext-derived digest lets the
   * state snapshot prove a second apply re-wrote the same value.
   */
  actions_secret_digests: Record<string, string>;
  dependabot_secret_digests: Record<string, string>;
  codespaces_secret_digests: Record<string, string>;
  agents_secret_digests: Record<string, string>;
  environment_secret_digests: Record<string, Record<string, string>>;
  workflows: Json[];
  pages: Json | null;
  code_scanning: Json;
  code_quality: Json;
  check_suite_preferences: Json;
  collaborators: Json[];
  /** Pending repository invitations in the repository-invitation GET shape. */
  invitations: Json[];
  teams: Record<string, { role_name: string } | null>;
  milestones: Json[];
  /** The active interaction limit, or null when none is set. */
  interaction_limits: Json | null;
  interaction_limits_org_override: boolean;
  /** The pull request creation cap ({enabled, max_open_pull_requests}). */
  pull_creation_cap: Json;
  pull_creation_cap_unavailable: boolean;
  /** The creation-cap bypass list, simple-user objects in GET shape. */
  pull_bypass_list: Json[];
  actions_variables: Json[];
  /** Copilot agents repository variables, same GET shape as actions_variables. */
  agents_variables: Json[];
  /** Repository webhooks; config.secret is stored real, GETs echo "********". */
  hooks: Json[];
  /** Deploy keys in GET shape; stored key material carries no comment. */
  deploy_keys: Json[];
  /** Report issues the private-report issue channel lists/creates/patches. */
  issues: Json[];
  /** Custom property values set on the repo ({property_name, value}). */
  custom_property_values: Json[];
  /** Secret scanning custom patterns in GET shape. */
  secret_scanning_patterns: Json[];
  /**
   * Feeds each create's and update's fresh custom_pattern_version, deterministic rather than a clock.
   * Underscore prefix: mock bookkeeping, excluded from the idempotence snapshot (snapshotFamilies in
   * apply-idempotence-proof.ts).
   */
  _secret_scanning_version_counter: number;
  nextId: number;
}

export function normalizePinnedSeed(
  seed: ReadonlyArray<string | { name: string; position: number }>,
): Array<{ name: string; position: number }> {
  let max = 0;
  const pins = seed.map((entry) => {
    if (typeof entry === "string") {
      max += 1;
      return { name: entry, position: max };
    }
    max = Math.max(max, entry.position);
    return { name: entry.name, position: entry.position };
  });
  return pins.sort((a, b) => a.position - b.position);
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Runs last in buildState, after the repo is re-slugged and `state.slug` is fixed: the slug is part of
 * every id, so an id minted earlier would name the fixture. Write handlers mint with the same codec
 * (mock/node-id.ts).
 */
function stampNodeIds(state: MockState): void {
  state.repo.node_id = mintNodeId("repo", state.slug, "");
  for (const [name, environment] of Object.entries(state.environments)) {
    environment.node_id = mintNodeId("environment", state.slug, name);
  }
  for (const rule of state.branch_protection_rules) {
    rule.id = mintNodeId("rule", state.slug, String(rule.pattern));
  }
}

/**
 * Repo fields only GraphQL serves, mirroring live GitHub: the issue creation policy is REST-blind in both
 * directions (the repo PATCH answers 200 and ignores it, no GET returns it) and the sponsor button has no
 * REST field. They live on state.repo so live_state.repo seeds them and the snapshot sees them; every
 * REST-served or REST-accepted repo body passes through restRepoSurface, which strips them.
 */
const GRAPHQL_ONLY_REPO_FIELDS = ["has_sponsorships_enabled", "issue_creation_policy"] as const;

export function restRepoSurface(repo: Json): Json {
  const view = { ...repo };
  for (const field of GRAPHQL_ONLY_REPO_FIELDS) {
    delete view[field];
  }
  return view;
}

function deepMerge(base: Json, overlay: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const prev = out[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value;
  }
  return out;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function generateLabels(gen: LabelsGenerate): Json[] {
  return Array.from({ length: gen.count }, (_, i) => ({
    name: `${gen.prefix}-${i + 1}`,
    color: gen.color,
  }));
}

/**
 * The list collections buildState completes from the same spec their handlers create with, so a
 * seed is served exactly as a created item would be: the spec's defaults under the seed and the
 * server-owned fields minted over it (a seed may pin only its id). The state test pins the key set.
 */
export const LIST_MOCKS = {
  labels: LABELS_MOCK,
  autolinks: AUTOLINKS_MOCK,
  deploy_keys: DEPLOY_KEYS_MOCK,
} as const satisfies Partial<Record<ListSectionKey, ListMockSpec>>;

function completeListItem(spec: ListMockSpec, seed: Json, id: number, slug: string): Json {
  const item = { ...spec.defaults, ...seed };
  return { ...item, ...spec.owned(id, slug, item) };
}

function seededIds(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.flatMap(seededIds);
  }
  if (!isPlainObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    key === "id" && typeof nested === "number" ? [nested] : seededIds(nested),
  );
}

function completeListCollections(state: MockState): void {
  for (const spec of Object.values(LIST_MOCKS)) {
    const items = spec.collection(state);
    const completed = items.map((seed) =>
      completeListItem(
        spec,
        seed,
        typeof seed.id === "number" ? seed.id : state.nextId++,
        state.slug,
      ),
    );
    items.splice(0, items.length, ...completed);
  }
}

/**
 * The urls derive from `slug` (the owning state's fixed identity), so a multi-repo target's hooks name
 * the target; the timestamps are FIXED so a repeat apply leaves the state byte-stable for the
 * idempotence proof.
 */
export function completeHook(seed: Json, id: number, slug: string): Json {
  const hookId = Number(seed.id ?? id);
  return {
    type: "Repository",
    name: "web",
    active: true,
    events: ["push"],
    config: {},
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    url: `https://api.github.com/repos/${slug}/hooks/${hookId}`,
    test_url: `https://api.github.com/repos/${slug}/hooks/${hookId}/test`,
    ping_url: `https://api.github.com/repos/${slug}/hooks/${hookId}/pings`,
    deliveries_url: `https://api.github.com/repos/${slug}/hooks/${hookId}/deliveries`,
    last_response: { code: null, status: "unused", message: null },
    id: hookId,
    ...seed,
  };
}

/**
 * The same completion the PUT handler stores, so a seed is served exactly as a created user would be.
 * Deterministic (no clocks, no randomness) so repeat applies leave the state byte-stable.
 */
export function bypassUser(seed: Json, id: number): Json {
  const login = String(seed.login ?? "");
  const userId = Number(seed.id ?? id);
  return {
    id: userId,
    node_id: `MDQ6VXNlcj${userId}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${userId}?v=4`,
    gravatar_id: "",
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: "User",
    site_admin: false,
    ...seed,
    login,
  };
}

/**
 * The scaffold derives from `repo` and the state's fixed `slug`, so a multi-mode target's invitation
 * names the target, not the fixture; the timestamp is FIXED for the idempotence proof.
 */
export function completeInvitation(seed: Json, id: number, repo: Json, slug: string): Json {
  const invitationId = Number(seed.id ?? id);
  const ownerLogin = String((repo.owner as Json | undefined)?.login ?? slug.split("/")[0]);
  // An explicit `invitee: null` seeds an EMAIL invitation (the spec's invitee is nullable).
  const invitee =
    seed.invitee === null
      ? null
      : {
          login: "invitee",
          id: 0,
          type: "User",
          site_admin: false,
          ...((seed.invitee as Json | undefined) ?? {}),
        };
  const completed: Json = {
    node_id: `MDEwOlJlcG9JbnZpdGF0aW9u${invitationId}`,
    // A CLONE, not the live reference: a stored invitation mirroring later repo mutations would make
    // snapshotFamilies (apply-idempotence-proof.ts) misattribute a repo change to invitations.
    repository: clone(repo),
    inviter: { login: ownerLogin, id: 0, type: "User", site_admin: false },
    permissions: "write",
    expired: false,
    created_at: "2026-07-01T00:00:00Z",
    url: `https://api.github.com/repos/${slug}/invitations/${invitationId}`,
    html_url: `https://github.com/${slug}/invitations`,
    ...seed,
    invitee,
    id: invitationId,
  };
  // AFTER the seed spread, so a seeded repository object is projected too: a REST surface like any other.
  completed.repository = restRepoSurface(completed.repository as Json);
  return completed;
}

/**
 * The ONE source of protection-rule App slugs: the create handler resolves integration_id against it and
 * the fuzz generator draws declared slugs from it, so a generated rule can always be enabled.
 */
export const PROTECTION_RULE_APPS: readonly Json[] = [
  {
    id: 3515,
    slug: "deploy-gate",
    integration_url: "https://api.github.com/apps/deploy-gate",
    node_id: "MDQ6R2F0ZTM1MTU=",
  },
  {
    id: 3516,
    slug: "region-guard",
    integration_url: "https://api.github.com/apps/region-guard",
    node_id: "MDQ6R2F0ZTM1MTY=",
  },
  {
    id: 3517,
    slug: "change-window",
    integration_url: "https://api.github.com/apps/change-window",
    node_id: "MDQ6R2F0ZTM1MTc=",
  },
];

/**
 * The ONE source of defined custom property names: the values PATCH answers 422 for a name outside it,
 * and the fuzz generator draws declared names (with type-appropriate values) from it.
 */
export const CUSTOM_PROPERTY_DEFINITIONS: ReadonlyArray<{
  property_name: string;
  value_type: "string" | "true_false" | "multi_select";
  allowed_values?: readonly string[];
}> = [
  { property_name: "team", value_type: "string" },
  // A second string property, so a scenario can seed an UNDECLARED live
  // value on a defined name without colliding with the declared ones.
  { property_name: "tier", value_type: "string" },
  { property_name: "pilot", value_type: "true_false" },
  { property_name: "compliance", value_type: "multi_select", allowed_values: ["soc2", "hipaa"] },
];

/**
 * `slug` (multi-repo targets) re-slugs the repo BEFORE any family completion runs, so bodies derived
 * from the repo (hook urls, the invitation scaffold) name the target, not the fixture.
 */
export function buildState(
  liveState: LiveState | undefined,
  ownerKind: OwnerKind,
  slug?: string,
): MockState {
  const ls = liveState ?? {};
  // So a pinned seed id can never collide with a minted one.
  let nextId = Math.max(90_000_000, ...seededIds(ls).map((id) => id + 1));
  const takeId = (): number => nextId++;

  // deepMerge assigns overlay values by reference, so both sides are cloned: the fixture singleton stays
  // private (a later reslugRepo would otherwise write owner.login into every scenario), and the
  // scenario's live_state.repo stays private from in-place handler mutations.
  const repo = ls.repo
    ? deepMerge(clone(repoFixture as Json), clone(ls.repo))
    : clone(repoFixture as Json);
  if (slug !== undefined) {
    reslugRepo(repo, slug);
  }
  // The identity is fixed here and never moves with a later PATCH of full_name; a seed that blanks
  // full_name fails loudly instead of minting ids under a garbage slug.
  const fullName = repo.full_name;
  if (slug === undefined && (typeof fullName !== "string" || fullName === "")) {
    throw new Error(
      `buildState: live_state.repo.full_name must be a non-empty string when no slug is given, got ${JSON.stringify(fullName)}`,
    );
  }
  const stateSlug = slug ?? String(fullName);

  const labels =
    ls.labels === undefined
      ? []
      : Array.isArray(ls.labels)
        ? clone(ls.labels)
        : generateLabels(ls.labels.generate);

  const pinnedSeed = normalizePinnedSeed(ls.pinned_environments ?? []);

  const state: MockState = {
    slug: stateSlug,
    ownerKind,
    org: ownerKind === "user" ? null : clone(orgFixture as Json),
    repo,
    labels,
    rulesets: ls.rulesets ? clone(ls.rulesets) : [],
    branch_protection: ls.branch_protection ? clone(ls.branch_protection) : {},
    branch_protection_graphql: ls.branch_protection_graphql
      ? clone(ls.branch_protection_graphql)
      : {},
    branch_protection_rules: (ls.branch_protection_rules ?? []).map((rule) =>
      completeRule(clone(rule)),
    ),
    branches: ls.branches ? clone(ls.branches) : [],
    environments: ls.environments ? clone(ls.environments) : {},
    environment_variables: ls.environment_variables ? clone(ls.environment_variables) : {},
    environment_branch_policies: ls.environment_branch_policies
      ? clone(ls.environment_branch_policies)
      : {},
    environment_protection_rules: ls.environment_protection_rules
      ? clone(ls.environment_protection_rules)
      : {},
    pinned_environments: pinnedSeed,
    _pinned_position_counter: Math.max(0, ...pinnedSeed.map((pin) => pin.position)),
    autolinks: ls.autolinks ? clone(ls.autolinks) : [],
    actions_permissions: ls.actions_permissions ? clone(ls.actions_permissions) : {},
    selected_actions: ls.selected_actions ? clone(ls.selected_actions) : {},
    workflow_permissions: ls.workflow_permissions ? clone(ls.workflow_permissions) : {},
    actions_access: ls.actions_access ? clone(ls.actions_access) : {},
    // GitHub's real defaults, not {}: each body carries required fields, so
    // an unseeded GET must still answer a spec-valid shape.
    actions_retention: ls.actions_retention
      ? clone(ls.actions_retention)
      : { days: 90, maximum_allowed_days: 400 },
    cache_retention_limit: ls.cache_retention_limit
      ? clone(ls.cache_retention_limit)
      : { max_cache_retention_days: 7 },
    cache_storage_limit: ls.cache_storage_limit
      ? clone(ls.cache_storage_limit)
      : { max_cache_size_gb: 10 },
    oidc_customization_sub: ls.oidc_customization_sub
      ? clone(ls.oidc_customization_sub)
      : { use_default: true },
    fork_pr_contributor_approval: ls.fork_pr_contributor_approval
      ? clone(ls.fork_pr_contributor_approval)
      : { approval_policy: "first_time_contributors_new_to_github" },
    fork_pr_workflows_private_repos: ls.fork_pr_workflows_private_repos
      ? clone(ls.fork_pr_workflows_private_repos)
      : {
          run_workflows_from_fork_pull_requests: false,
          send_write_tokens_to_workflows: false,
          send_secrets_and_variables: false,
          require_approval_for_fork_pr_workflows: true,
        },
    actions_secrets: ls.actions_secrets ? clone(ls.actions_secrets) : [],
    dependabot_secrets: ls.dependabot_secrets ? clone(ls.dependabot_secrets) : [],
    codespaces_secrets: ls.codespaces_secrets ? clone(ls.codespaces_secrets) : [],
    agents_secrets: ls.agents_secrets ? clone(ls.agents_secrets) : [],
    environment_secrets: ls.environment_secrets ? clone(ls.environment_secrets) : {},
    _secret_write_counter: 0,
    actions_secret_digests: {},
    dependabot_secret_digests: {},
    codespaces_secret_digests: {},
    agents_secret_digests: {},
    environment_secret_digests: {},
    workflows: ls.workflows ? clone(ls.workflows) : [],
    pages: ls.pages !== undefined ? clone(ls.pages) : null,
    code_scanning: ls.code_scanning ? clone(ls.code_scanning) : {},
    // GitHub's fresh-repo default, not {}: the GET body's nullable fields
    // are spelled out so an unseeded read answers a realistic shape.
    code_quality: ls.code_quality
      ? clone(ls.code_quality)
      : {
          state: "not-configured",
          languages: [],
          runner_type: null,
          runner_label: null,
          updated_at: null,
          schedule: null,
          ai_findings_option: null,
        },
    check_suite_preferences: ls.check_suite_preferences
      ? clone(ls.check_suite_preferences)
      : { auto_trigger_checks: [] },
    collaborators: ls.collaborators ? clone(ls.collaborators) : [],
    invitations: (ls.invitations ?? []).map((invitation) =>
      completeInvitation(clone(invitation), takeId(), repo, stateSlug),
    ),
    teams: ls.teams ? clone(ls.teams) : {},
    milestones: ls.milestones ? clone(ls.milestones) : [],
    interaction_limits: ls.interaction_limits ? clone(ls.interaction_limits) : null,
    interaction_limits_org_override: ls.interaction_limits_org_override ?? false,
    // An unconfigured repo's cap is disabled; the spec requires
    // max_open_pull_requests in every response, so the default carries one.
    pull_creation_cap: ls.pull_creation_cap
      ? clone(ls.pull_creation_cap)
      : { enabled: false, max_open_pull_requests: 1 },
    pull_creation_cap_unavailable: ls.pull_creation_cap_unavailable ?? false,
    pull_bypass_list: (ls.pull_bypass_list ?? []).map((user) => bypassUser(clone(user), takeId())),
    actions_variables: ls.actions_variables ? clone(ls.actions_variables) : [],
    agents_variables: ls.agents_variables ? clone(ls.agents_variables) : [],
    hooks: (ls.hooks ?? []).map((hook) => completeHook(clone(hook), takeId(), stateSlug)),
    deploy_keys: ls.deploy_keys ? clone(ls.deploy_keys) : [],
    issues: ls.issues ? clone(ls.issues) : [],
    custom_property_values: ls.custom_property_values ? clone(ls.custom_property_values) : [],
    secret_scanning_patterns: ls.secret_scanning_patterns ? clone(ls.secret_scanning_patterns) : [],
    _secret_scanning_version_counter: 0,
    nextId,
  };
  completeListCollections(state);
  stampNodeIds(state);
  return state;
}

// --- Multi-repo layer -----------------------------------------------------
//
// One admin repo (e2e-owner/e2e-repo) runs against many target slugs. MultiMockState wraps a
// Map<slug, MockState> instead of re-keying MockState, which every handler and round-trip test depends
// on; the pipeline resolves the slug from the request path and dispatches into the per-slug state.

export interface MultiRepoSpec {
  /**
   * The settings.yml body the contents endpoint serves, or null for NO file (the contents 404 path: the
   * defaults document applies, or the target is skipped without one).
   */
  settingsYaml: string | null;
  liveState?: LiveState;
  permissions?: PermissionMask;
}

/**
 * A `/user/repos` pool entry. The mock applies only GitHub's server-side visibility filter (core-paths.ts);
 * the action filters the other attributes client-side, so the pool carries them verbatim.
 */
export interface DiscoveryRepoSpec {
  slug: string;
  archived?: boolean;
  fork?: boolean;
  visibility?: string;
  topics?: string[];
}

export interface MultiMockState {
  /** Per-target working state, keyed by "owner/name" slug. */
  repos: Map<string, MockState>;
  /** The raw settings.yml each slug serves (null = no file), keyed by slug. */
  settings: Map<string, string | null>;
  /** Per-slug permission mask, merged OVER the scenario's global mask (grading.ts), so {} inherits its denials. */
  permissions: Map<string, PermissionMask>;
  /** The repo objects `/user/repos` enumerates (discovery pool). */
  discoveryPool: Json[];
  /**
   * Shared state for the org-level endpoints (the `GET /orgs/{org}` probe), which are NOT repo-scoped;
   * only its `org` field is read. Team-repo routes still resolve to the addressed repo's state via their
   * {owner}/{repo} tail.
   */
  orgState: MockState;
}

/**
 * The fixture's url fields all name the repository, so a target left on them would point at another
 * repo; only `url`/`*_url` keys are rewritten because a seeded description mentioning the fixture owner
 * is content, not identity. Substitution goes through placeholder tokens: a sequential owner pass would
 * re-match the old owner inside a new identity that contains it.
 *   e2e-owner-fork/service  -> would come out as e2e-owner-fork-fork/service
 *   acme/my-e2e-owner-repo  -> would come out as acme/my-<owner>-repo
 */
function reslugRepo(repo: Json, slug: string): void {
  const [owner, name] = slug.split("/");
  const oldSlug = typeof repo.full_name === "string" ? repo.full_name : "";
  const ownerObj = repo.owner;
  const oldOwner =
    isPlainObject(ownerObj) && typeof ownerObj.login === "string" ? ownerObj.login : "";
  // NUL-delimited tokens: a url string can never legitimately contain NUL, so they cannot collide.
  const SLUG_TOKEN = "\u0000slug\u0000";
  const OWNER_TOKEN = "\u0000owner\u0000";
  const rewriteUrl = (value: string): string => {
    let out = value;
    if (oldSlug !== "") {
      out = out.replaceAll(oldSlug, SLUG_TOKEN);
    }
    if (oldOwner !== "") {
      out = out.replaceAll(oldOwner, OWNER_TOKEN);
    }
    return out.replaceAll(SLUG_TOKEN, slug).replaceAll(OWNER_TOKEN, owner ?? "");
  };
  const rewriteUrlFields = (obj: Json): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string" && (key === "url" || key.endsWith("_url"))) {
        obj[key] = rewriteUrl(value);
      } else if (isPlainObject(value)) {
        rewriteUrlFields(value);
      }
    }
  };
  rewriteUrlFields(repo);
  repo.full_name = slug;
  repo.name = name ?? slug;
  if (isPlainObject(ownerObj)) {
    ownerObj.login = owner ?? "";
  }
}

export function buildStateForSlug(
  slug: string,
  spec: MultiRepoSpec,
  ownerKind: OwnerKind,
): MockState {
  return buildState(spec.liveState, ownerKind, slug);
}

/**
 * Only the fields discovery reads need be realistic; the top-level node id is still minted, as
 * stampNodeIds does for a per-slug state.
 */
function discoveryRepoBody(spec: DiscoveryRepoSpec): Json {
  const body = restRepoSurface(clone(repoFixture as Json));
  reslugRepo(body, spec.slug);
  body.node_id = mintNodeId("repo", spec.slug, "");
  if (spec.archived !== undefined) {
    body.archived = spec.archived;
  }
  if (spec.fork !== undefined) {
    body.fork = spec.fork;
  }
  if (spec.visibility !== undefined) {
    body.visibility = spec.visibility;
  }
  if (spec.topics !== undefined) {
    body.topics = spec.topics;
  }
  return body;
}

export function buildMultiState(
  repos: Record<string, MultiRepoSpec>,
  discoveryPool: DiscoveryRepoSpec[] | undefined,
  ownerKind: OwnerKind,
): MultiMockState {
  const state: MultiMockState = {
    repos: new Map(),
    settings: new Map(),
    permissions: new Map(),
    discoveryPool: (discoveryPool ?? []).map(discoveryRepoBody),
    // The org-level endpoints read only `org`; a default MockState carries the org fixture (or null).
    orgState: buildState(undefined, ownerKind),
  };
  const ensure = (slug: string, spec: MultiRepoSpec): void => {
    state.repos.set(slug, buildStateForSlug(slug, spec, ownerKind));
    state.settings.set(slug, spec.settingsYaml);
    state.permissions.set(slug, spec.permissions ?? {});
  };
  for (const [slug, spec] of Object.entries(repos)) {
    ensure(slug, spec);
  }
  // The pool's visibility is carried into the default state: a discovered PRIVATE repo is deliverable
  // without a probe, but the mock's report delivery gate reads the per-slug state's visibility, which
  // would otherwise default to public and wrongly reject the delivery.
  for (const pool of discoveryPool ?? []) {
    if (state.repos.has(pool.slug)) {
      continue;
    }
    const liveState =
      pool.visibility === undefined
        ? undefined
        : { repo: { visibility: pool.visibility, private: pool.visibility !== "public" } };
    ensure(pool.slug, { settingsYaml: null, liveState });
  }
  return state;
}

// --- Write-to-read transformers ------------------------------------------

function expandActors(value: unknown, nameKey: "login" | "slug"): Json[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((name) => ({ [nameKey]: String(name) }));
}

function enabledObject(value: unknown): Json {
  return { enabled: value === true };
}

/**
 * Read back by branches' `flattenProtection`. Only keys present in the payload are emitted: the section
 * reports omitted live keys as drift (omittedLiveDrift), so a phantom key can break convergence;
 * required_signatures is dropped because GitHub's PUT silently discards it (its own sub-endpoint sets it).
 */
export function protectionFromPut(payload: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null) {
      // A null core key (restrictions: null) unsets it, and GitHub's GET shape then carries no such key.
      continue;
    }
    switch (key) {
      case "required_signatures":
        break;
      case "enforce_admins":
      case "required_linear_history":
      case "allow_force_pushes":
      case "allow_deletions":
      case "block_creations":
      case "required_conversation_resolution":
      case "lock_branch":
      case "allow_fork_syncing":
        out[key] = enabledObject(value);
        break;
      case "restrictions": {
        const r = value as Json;
        out.restrictions = {
          users: expandActors(r.users, "login"),
          teams: expandActors(r.teams, "slug"),
          apps: expandActors(r.apps, "slug"),
        };
        break;
      }
      case "required_pull_request_reviews": {
        const rpr = value as Json;
        const nested: Json = { ...rpr };
        const dr = rpr.dismissal_restrictions;
        if (isPlainObject(dr)) {
          nested.dismissal_restrictions = {
            users: expandActors(dr.users, "login"),
            teams: expandActors(dr.teams, "slug"),
            apps: expandActors(dr.apps, "slug"),
          };
        }
        const bp = rpr.bypass_pull_request_allowances;
        if (isPlainObject(bp)) {
          nested.bypass_pull_request_allowances = {
            users: expandActors(bp.users, "login"),
            teams: expandActors(bp.teams, "slug"),
            apps: expandActors(bp.apps, "slug"),
          };
        }
        out.required_pull_request_reviews = nested;
        break;
      }
      default:
        out[key] = value;
    }
  }
  return out;
}

// --- Branch protection rules (the GraphQL surface) --------------------------
//
// The rules query serves the UNION of literal rules (branch_protection projected into rule nodes) and
// wildcard rules (branch_protection_rules). The projection imports the branches section's own twin
// tables; state.test.ts proves the section's classicViewOfRule inverts it.

/** The users a force_push_bypassers entry can name; the actor-user lookup answers NOT_FOUND for anything else. */
export const BYPASS_ACTOR_USERS: readonly string[] = ["octocat", "release-bot"];

/**
 * The org teams the actor-team lookup resolves; an unknown org answers NOT_FOUND, a known org with an
 * unknown team answers team: null (GitHub's nullable-field shape).
 */
export const BYPASS_ACTOR_TEAMS: readonly string[] = [
  `${ADMIN_OWNER}/platform`,
  `${ADMIN_OWNER}/release-guild`,
];

/**
 * GitHub's fresh-rule defaults under the seed; the GraphQL type's booleans are non-null, so the wire node
 * needs every field. The id is stamped by stampNodeIds or minted by the create handler.
 */
export function completeRule(seed: Json): Json {
  return {
    pattern: "*",
    isAdminEnforced: false,
    requiresLinearHistory: false,
    allowsForcePushes: false,
    allowsDeletions: false,
    blocksCreations: false,
    requiresConversationResolution: false,
    lockBranch: false,
    lockAllowsFetchAndMerge: false,
    requiresCommitSignatures: false,
    requiresStatusChecks: false,
    requiresStrictStatusChecks: false,
    requiredStatusCheckContexts: [],
    requiresApprovingReviews: false,
    requiredApprovingReviewCount: null,
    requiresCodeOwnerReviews: false,
    dismissesStaleReviews: false,
    requireLastPushApproval: false,
    requiresDeployments: false,
    requiredDeploymentEnvironments: [],
    bypassForcePushActors: [],
    ...seed,
  };
}

function bypassAllowanceNodes(actors: unknown): Json {
  const list = Array.isArray(actors) ? actors.map(String) : [];
  return {
    nodes: list.map((raw) => {
      const actor = parseBypassActor(raw);
      if (actor === null) {
        return { actor: null };
      }
      if (actor.kind === "user") {
        return { actor: { __typename: "User", login: actor.login } };
      }
      if (actor.kind === "team") {
        return { actor: { __typename: "Team", combinedSlug: raw } };
      }
      return { actor: { __typename: "App", slug: actor.slug } };
    }),
    // The section reads one 100-node page and fails loudly on a truncation signal; the mock's lists never exceed that.
    pageInfo: { hasNextPage: false },
  };
}

export function ruleWireNode(stored: Json): Json {
  const { bypassForcePushActors, ...fields } = stored;
  return { ...fields, bypassForcePushAllowances: bypassAllowanceNodes(bypassForcePushActors) };
}

function enabledOf(value: unknown): boolean {
  return isPlainObject(value) ? value.enabled === true : value === true;
}

/**
 * The inverse of the section's classicViewOfRule, proven by state.test.ts; the GraphQL-only extras
 * family is merged over the translated twins.
 */
export function ruleFromProtection(
  pattern: string,
  protection: Json,
  extras: Json | undefined,
  slug: string,
): Json {
  const stored = completeRule({ pattern });
  stored.id = mintNodeId("rule", slug, pattern);
  for (const [classic, twin] of Object.entries(GRAPHQL_BOOLEAN_TWINS)) {
    if (classic in protection) {
      stored[twin] = enabledOf(protection[classic]);
    }
  }
  const checks = protection.required_status_checks;
  if (isPlainObject(checks)) {
    stored.requiresStatusChecks = true;
    if ("strict" in checks) {
      stored.requiresStrictStatusChecks = checks.strict === true;
    }
    if (Array.isArray(checks.contexts)) {
      stored.requiredStatusCheckContexts = [...checks.contexts];
    }
  }
  const reviews = protection.required_pull_request_reviews;
  if (isPlainObject(reviews)) {
    stored.requiresApprovingReviews = true;
    for (const [classic, twin] of Object.entries(GRAPHQL_REVIEW_TWINS)) {
      if (classic in reviews) {
        stored[twin] = reviews[classic];
      }
    }
  }
  if (extras) {
    Object.assign(stored, extras);
  }
  return ruleWireNode(stored);
}

/** Sorted by pattern for determinism. REST GETs never see the wildcard family, mirroring GitHub. */
export function allRuleNodes(state: MockState): Json[] {
  const slug = state.slug;
  const nodes: Json[] = [];
  for (const [branch, protection] of Object.entries(state.branch_protection)) {
    if (protection) {
      nodes.push(
        ruleFromProtection(branch, protection, state.branch_protection_graphql[branch], slug),
      );
    }
  }
  for (const rule of state.branch_protection_rules) {
    nodes.push(ruleWireNode(rule));
  }
  nodes.sort((a, b) => String(a.pattern).localeCompare(String(b.pattern)));
  return nodes;
}

/**
 * GitHub's verified silent drop, mimicked: the mutation keeps only names of existing environments and
 * succeeds regardless, so the section's read-back check is what must catch a dropped name. Environment
 * names are case-insensitive on GitHub, so a kept name echoes the STORED spelling.
 */
function dropMissingEnvironments(names: unknown, state: MockState): string[] {
  const canonical = new Map(
    Object.keys(state.environments).map((name) => [name.toLowerCase(), name]),
  );
  const out: string[] = [];
  for (const name of Array.isArray(names) ? names.map(String) : []) {
    const stored = canonical.get(name.toLowerCase());
    if (stored !== undefined) {
      out.push(stored);
    }
  }
  return out;
}

function actorStringsFromIds(ids: unknown): { actors: string[] } | { bad: string } {
  const out: string[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const decoded = decodeNodeId(String(id));
    if (decoded === null) {
      return { bad: String(id) };
    }
    if (decoded.family === "user" || decoded.family === "team") {
      out.push(decoded.key);
    } else if (decoded.family === "app") {
      out.push(`app/${decoded.key}`);
    } else {
      return { bad: String(id) };
    }
  }
  return { actors: out };
}

export function applyRuleInput(
  stored: Json,
  input: Json,
  state: MockState,
): { ok: true } | { bad: string } {
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "branchProtectionRuleId":
      case "repositoryId":
      case "clientMutationId":
        break;
      case "pattern":
        stored.pattern = String(value);
        break;
      case "bypassForcePushActorIds": {
        const decoded = actorStringsFromIds(value);
        if ("bad" in decoded) {
          return decoded;
        }
        stored.bypassForcePushActors = decoded.actors;
        break;
      }
      case "requiredDeploymentEnvironments":
        stored.requiredDeploymentEnvironments = dropMissingEnvironments(value, state);
        break;
      default:
        stored[key] = value;
    }
  }
  return { ok: true };
}

const CLASSIC_BY_TWIN: Record<string, string> = Object.fromEntries(
  Object.entries(GRAPHQL_BOOLEAN_TWINS).map(([classic, twin]) => [twin, classic]),
);

const REVIEW_CLASSIC_BY_TWIN: Record<string, string> = Object.fromEntries(
  Object.entries(GRAPHQL_REVIEW_TWINS).map(([classic, twin]) => [twin, classic]),
);

const STATUS_CLASSIC_BY_TWIN: Record<string, string> = Object.fromEntries(
  Object.entries(GRAPHQL_STATUS_CHECK_TWINS).map(([classic, twin]) => [twin, classic]),
);

/**
 * Translated twins land back on the stored REST GET shape and GraphQL-only fields on the extras family,
 * so both views keep agreeing: GitHub has one underlying rule.
 */
export function applyRuleInputToLiteral(
  state: MockState,
  branch: string,
  input: Json,
): { ok: true } | { bad: string } {
  const protection = state.branch_protection[branch] as Json;
  if (state.branch_protection_graphql[branch] === undefined) {
    state.branch_protection_graphql[branch] = {};
  }
  const extras = state.branch_protection_graphql[branch] as Json;
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "branchProtectionRuleId":
      case "clientMutationId":
        break;
      case "bypassForcePushActorIds": {
        const decoded = actorStringsFromIds(value);
        if ("bad" in decoded) {
          return decoded;
        }
        extras.bypassForcePushActors = decoded.actors;
        break;
      }
      case "requiresDeployments":
        extras.requiresDeployments = value === true;
        break;
      case "requiredDeploymentEnvironments":
        extras.requiredDeploymentEnvironments = dropMissingEnvironments(value, state);
        break;
      case "requiresStatusChecks":
        if (value !== true) {
          delete protection.required_status_checks;
        } else if (!isPlainObject(protection.required_status_checks)) {
          protection.required_status_checks = { strict: false, contexts: [] };
        }
        break;
      case "requiresApprovingReviews":
        if (value !== true) {
          delete protection.required_pull_request_reviews;
        } else if (!isPlainObject(protection.required_pull_request_reviews)) {
          protection.required_pull_request_reviews = {};
        }
        break;
      default: {
        const classicBoolean = CLASSIC_BY_TWIN[key];
        if (classicBoolean !== undefined) {
          protection[classicBoolean] = { enabled: value === true };
          break;
        }
        const classicReview = REVIEW_CLASSIC_BY_TWIN[key];
        if (classicReview !== undefined) {
          if (!isPlainObject(protection.required_pull_request_reviews)) {
            protection.required_pull_request_reviews = {};
          }
          (protection.required_pull_request_reviews as Json)[classicReview] = value;
          break;
        }
        const classicStatus = STATUS_CLASSIC_BY_TWIN[key];
        if (classicStatus !== undefined) {
          if (!isPlainObject(protection.required_status_checks)) {
            protection.required_status_checks = { strict: false, contexts: [] };
          }
          (protection.required_status_checks as Json)[classicStatus] = value;
          break;
        }
        // A field with no classic destination (a future twin) stays on the extras so a read-back echoes it.
        extras[key] = value;
      }
    }
  }
  return { ok: true };
}

/**
 * Read back by environments' `flattenEnvironment`: a reviewer's `id` nests under `reviewer` while its
 * `type` stays top-level, matching the flattener's extraction.
 */
export function environmentFromPut(payload: Json): Json {
  const { wait_timer, prevent_self_review, reviewers, ...rest } = payload;
  const rules: Json[] = [];
  if (wait_timer !== undefined) {
    rules.push({ type: "wait_timer", wait_timer });
  }
  if (prevent_self_review !== undefined || reviewers !== undefined) {
    const rule: Json = { type: "required_reviewers" };
    if (prevent_self_review !== undefined) {
      rule.prevent_self_review = prevent_self_review;
    }
    if (Array.isArray(reviewers)) {
      rule.reviewers = reviewers.map((r) => {
        const reviewer = r as { type?: unknown; id?: unknown };
        return { type: reviewer.type, reviewer: { id: reviewer.id } };
      });
    }
    rules.push(rule);
  }
  return { ...rest, protection_rules: rules };
}

/**
 * For an EXISTING collaborator; a PUT for a non-collaborator creates a pending invitation instead
 * (invitationFromPut). role_name comes from the shared `roleForPermission`, the same map the section
 * applies to its declaration before comparing.
 */
export function collaboratorFromPut(username: string, payload: Json): Json {
  const permission = String(payload.permission ?? "push");
  return {
    login: username,
    id: 0,
    type: "User",
    site_admin: false,
    role_name: roleForPermission(permission),
  };
}

/**
 * Clamped into INVITATION_ROLES: GitHub never reports a custom role name on an invitation, only its base
 * grant, modeled here as "write".
 */
export function invitationPermissionFromPut(payload: Json): string {
  const role = roleForPermission(String(payload.permission ?? "push"));
  return INVITATION_ROLES.has(role) ? role : "write";
}

/** For a NON-collaborator: the stored invitation reads back exactly what the section compares pending invitations with. */
export function invitationFromPut(
  username: string,
  payload: Json,
  id: number,
  repo: Json,
  slug: string,
): Json {
  return completeInvitation(
    { invitee: { login: username }, permissions: invitationPermissionFromPut(payload) },
    id,
    repo,
    slug,
  );
}

/** Only `role_name` matters to the teams probe. */
export function teamRepoFromPut(payload: Json): { role_name: string } {
  const permission = String(payload.permission ?? "push");
  return { role_name: roleForPermission(permission) };
}
