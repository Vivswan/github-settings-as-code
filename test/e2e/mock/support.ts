/**
 * Shared building blocks for the mock's per-endpoint handlers. This module sits at the BOTTOM of the
 * mock's layering: the pipeline, the core-path and merged handler tables, and every section fragment
 * (src/sections/<key>/mock.ts) import it and it imports none of them, so a fragment can depend on it
 * without pulling the whole pipeline in.
 */

import type { SectionKey } from "../../../src/schema.js";
import { endpointPath } from "../../../src/sections/contract/endpoints.js";
import type { GraphqlTolerableError } from "../../../src/sections/contract/graphql.js";
import { type NameKey, nameKey } from "../../../src/sections/labels/index.js";
import type {
  SectionEndpointKey,
  SectionGraphqlKey,
  TaggedEndpoint,
  TaggedGraphqlOp,
} from "../../../src/sections/registry.js";
import type { SetupKey, SetupSectionModule } from "../../../src/sections/shared/setup-section.js";
import { variableKey } from "../../../src/sections/shared/variables-engine.js";
import { decodeNodeId, mintAppNodeId, mintNodeId } from "./node-id.js";
import {
  MOCK_SECRETS_KEY_ID,
  MOCK_SECRETS_PUBLIC_KEY,
  secretDigest,
  unsealSecretValue,
} from "./secrets.js";
import type { MockState } from "./state.js";

export type Json = Record<string, unknown>;

export interface MockResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /**
   * Marks a reply that REJECTS a deliberately off-spec request body: settings pass through to the API
   * verbatim, so scenarios send user typos the schema forbids and the handler answers GitHub's real 4xx.
   * The OpenAPI validator skips only the request-body SCHEMA check for these; body-presence checks and
   * response validation still apply.
   */
  requestOffSpec?: boolean;
}

/**
 * Everything a handler needs for one request. The chaos-corruption directive is applied by the pipeline
 * AFTER the handler returns, so it is not passed here.
 */
interface HandlerContext {
  state: MockState;
  endpoint: TaggedEndpoint;
  /**
   * Extraction and routing share one template walk, so a handler cannot disagree with its own ENDPOINTS
   * declaration about a param's position; the raw path is deliberately NOT exposed.
   *   declared token                 -> its URL-decoded value ({owner} and {repo} included)
   *   token missing from the route   -> throws a mock BUG naming the handler, the route, and the declared tokens
   */
  param(name: string): string;
  query: Record<string, string>;
  body: unknown;
  /**
   * For a field GitHub reveals only above the endpoint's own grade (a ruleset's bypass_actors,
   * admin-only), so the mock omits it like GitHub does.
   */
  grants(kind: "read" | "write"): boolean;
}

export type Handler = (ctx: HandlerContext) => MockResponse;

export type SectionRestHandlers<K extends SectionKey> = Readonly<
  Record<SectionEndpointKey<K>, Handler>
>;

export type SectionGraphqlHandlers<K extends SectionKey> = Readonly<
  Record<SectionGraphqlKey<K>, GraphqlHandler>
>;

// --- Pagination -----------------------------------------------------------

/**
 * Slices the way src/github/paginate.ts asks: per_page (100, or the endpoint's declared smaller pageSize)
 * and page=N, stopping on a short chunk. `cap` is the endpoint's documented maximum: GitHub clamps an
 * oversized per_page rather than honoring it, so a capped endpoint never serves more per page.
 */
export function slicePage<T>(
  items: readonly T[],
  query: Record<string, string>,
  cap?: number,
): T[] {
  const requested = clampInt(query.per_page, 100);
  const perPage = cap === undefined ? requested : Math.min(requested, cap);
  const page = clampInt(query.page, 1);
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function clampInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// --- Handler helpers ------------------------------------------------------

export function asObject(body: unknown): Json {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Json) : {};
}

export function ok(body: unknown): MockResponse {
  return { status: 200, body };
}

/** A 204 empty reply (the client normalizes an empty body to null). */
export function noContent(): MockResponse {
  return { status: 204, body: null };
}

/** The precondition every branch-policy pattern endpoint shares; they answer 404 otherwise, like GitHub. */
export function branchPoliciesEnabled(state: MockState, env: string): boolean {
  const environment = state.environments[env];
  if (!environment) {
    return false;
  }
  const flags = environment.deployment_branch_policy as
    | { custom_branch_policies?: unknown }
    | null
    | undefined;
  return flags?.custom_branch_policies === true;
}

/**
 * ONE handler registered under both teams.org and custom_properties.org, so the two cannot drift.
 * matchEndpoint resolves the shared route to the FIRST declaring section (teams); the custom_properties
 * registration exists for the completeness assertion.
 */
export const orgProbeHandler: Handler = ({ state }) => {
  if (state.org === null) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return ok(state.org);
};

/**
 * Every secret PUT moves updated_at like GitHub, without a real clock. One counter per state serves
 * EVERY family, so a mixed-family scenario's ordering stays deterministic.
 */
function secretWriteStamp(writeCount: number): string {
  return new Date(Date.UTC(2020, 0, 15, 0, 0, writeCount)).toISOString().replace(".000Z", "Z");
}

/** A secret family's enveloped list page: names and timestamps, never values. */
export function secretsList(list: Json[], query: Record<string, string>): MockResponse {
  return ok({ total_count: list.length, secrets: slicePage(list, query) });
}

/**
 * The crypto proof every secret family shares: the ciphertext is UNSEALED with the fixed test keypair,
 * verifying the client's key decode, sealed-box construction, and base64 round-trip in one step; the
 * state keeps a digest of the value, never the plaintext. 201 on create, 204 on update, like GitHub.
 */
export function sealedSecretPut(
  state: MockState,
  list: Json[],
  digests: Record<string, string>,
  name: string,
  body: unknown,
): MockResponse {
  const payload = asObject(body);
  if (payload.key_id !== MOCK_SECRETS_KEY_ID) {
    return {
      status: 422,
      body: { message: `key_id "${String(payload.key_id)}" does not match the sealing key` },
    };
  }
  const plaintext = unsealSecretValue(String(payload.encrypted_value ?? ""));
  if (plaintext === null) {
    // GitHub would store the garbage; the mock rejects it, so a broken client sealing path can never pass.
    return {
      status: 422,
      body: { message: "encrypted_value is not a sealed box for the advertised public key" },
    };
  }
  digests[name] = secretDigest(plaintext);
  state._secret_write_counter += 1;
  const stamp = secretWriteStamp(state._secret_write_counter);
  const existing = list.find((s) => s.name === name);
  if (existing) {
    (existing as Record<string, unknown>).updated_at = stamp;
    return noContent();
  }
  list.push({ name, created_at: stamp, updated_at: stamp });
  return { status: 201, body: {} };
}

export function secretRemove(
  list: Json[],
  digests: Record<string, string>,
  name: string,
): MockResponse {
  const index = list.findIndex((s) => s.name === name);
  if (index < 0) {
    return { status: 404, body: { message: "Not Found" } };
  }
  list.splice(index, 1);
  delete digests[name];
  return noContent();
}

// --- The secret/variable family factories -----------------------------------
//
// The secret and variable sections come in FAMILIES differing only in which MockState list they read, so
// their fragments are minted here. Compile-time completeness survives the factoring in two halves.
//   annotated per-role record          -> rejects a missing or typo'd role
//   fragment's SectionRestHandlers<K>  -> rejects a declared endpoint the factory does not serve
//   assertHandlerCompleteness()        -> the runtime backstop

/** Object.fromEntries erases the key type; the cast restores exactly what the construction just did. */
function keyedHandlers<K extends SectionKey, R extends string>(
  key: K,
  roles: Readonly<Record<R, Handler>>,
): Record<`${K}.${R}`, Handler> {
  return Object.fromEntries(
    Object.entries<Handler>(roles).map(([role, handler]) => [`${key}.${role}`, handler]),
  ) as Record<`${K}.${R}`, Handler>;
}

type SecretsFamilyKey =
  | "actions_secrets"
  | "dependabot_secrets"
  | "codespaces_secrets"
  | "agents_secrets";
type SecretDigestsKey<K extends SecretsFamilyKey> = K extends `${infer F}_secrets`
  ? `${F}_secret_digests`
  : never;

type SecretsRole = "list" | "publicKey" | "put" | "remove";

export function repoSecretsRestHandlers<K extends SecretsFamilyKey>(
  key: K,
): Record<`${K}.${SecretsRole}`, Handler> {
  const digestsKey = key.replace(/_secrets$/, "_secret_digests") as SecretDigestsKey<K>;
  const roles: Readonly<Record<SecretsRole, Handler>> = {
    list: ({ state, query }) => secretsList(state[key], query),
    publicKey: () => ok({ key_id: MOCK_SECRETS_KEY_ID, key: MOCK_SECRETS_PUBLIC_KEY }),
    put: ({ state, param, body }) =>
      sealedSecretPut(state, state[key], state[digestsKey], param("secret_name"), body),
    remove: ({ state, param }) => secretRemove(state[key], state[digestsKey], param("secret_name")),
  };
  return keyedHandlers(key, roles);
}

/** The repository-variables families (same GET shape, uppercase-stored names). */
type VariablesFamilyKey = "actions_variables" | "agents_variables";

type VariablesRole = "list" | "create" | "update" | "remove";

/**
 * The page cap comes from the endpoint DECLARATION, the single source the client's page loop and the
 * spec-derived pageSize sweep also read, so the mock can never clamp at a stale number.
 */
export function repoVariablesRestHandlers<K extends VariablesFamilyKey>(section: {
  key: K;
  endpoints: { list: { pageSize?: number } };
}): Record<`${K}.${VariablesRole}`, Handler> {
  const key = section.key;
  const list = (state: MockState): Json[] => state[key];
  const roles: Readonly<Record<VariablesRole, Handler>> = {
    list: ({ state, query }) =>
      ok({
        total_count: list(state).length,
        variables: slicePage(list(state), query, section.endpoints.list.pageSize),
      }),
    create: ({ state, body }) => {
      const payload = asObject(body);
      // GitHub stores variable names uppercased however they are entered. Payload spread FIRST so the
      // passthrough fields the section sends (and later subsetDiffs) read back; canonical fields normalize over them.
      const variable: Json = {
        ...payload,
        name: variableName(payload),
        value: payload.value ?? "",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      list(state).push(variable);
      // The documented 201 body is an empty object.
      return { status: 201, body: {} };
    },
    update: ({ state, param, body }) => {
      const name = variableKey(param("name"));
      const variable = list(state).find((v) => variableName(v) === name);
      if (!variable) {
        return { status: 404, body: { message: "Not Found" } };
      }
      const payload = asObject(body);
      if (typeof payload.name === "string") {
        variable.name = variableKey(payload.name);
      }
      if (payload.value !== undefined) {
        variable.value = payload.value;
      }
      // Passthrough fields update verbatim, mirroring the create path, so a
      // second apply's subsetDiff over them reads back what was written.
      for (const [field, value] of Object.entries(payload)) {
        if (VARIABLE_CANONICAL_KEYS.has(field)) {
          continue;
        }
        variable[field] = value;
      }
      return noContent();
    },
    remove: ({ state, param }) => {
      const name = variableKey(param("name"));
      const index = list(state).findIndex((v) => variableName(v) === name);
      if (index < 0) {
        return { status: 404, body: { message: "Not Found" } };
      }
      list(state).splice(index, 1);
      return noContent();
    },
  };
  return keyedHandlers(key, roles);
}

// --- The setup family factory -----------------------------------------------

const SETUP_STATE = {
  code_scanning_default_setup: "code_scanning",
  code_quality_setup: "code_quality",
} as const satisfies Record<SetupKey, keyof MockState>;

type SetupRole = keyof SetupSectionModule<SetupKey>["endpoints"] & string;

/** GitHub starts an async configuration run when the PATCH changes `languages`, hence the 202 with a run_id. */
export function setupRestHandlers<K extends SetupKey>(
  key: K,
): Record<`${K}.${SetupRole}`, Handler> {
  const setup = (state: MockState): Json => state[SETUP_STATE[key]];
  const roles: Readonly<Record<SetupRole, Handler>> = {
    get: ({ state }) => ok(setup(state)),
    update: ({ state, body, endpoint }) => {
      const live = setup(state);
      if (live.configuration_run_in_progress === true) {
        return { status: 409, body: { message: "A configuration run is already in progress" } };
      }
      const payload = asObject(body);
      const changesLanguages =
        "languages" in payload &&
        JSON.stringify(payload.languages) !== JSON.stringify(live.languages);
      Object.assign(live, payload);
      if (!changesLanguages) {
        return ok({});
      }
      const runId = state.nextId++;
      const path = endpointPath(endpoint.route).replace("{owner}/{repo}", state.slug);
      return {
        status: 202,
        body: { run_id: runId, run_url: `https://api.github.com${path}/runs/${runId}` },
      };
    },
  };
  return keyedHandlers(key, roles);
}

/** Deterministic expires_at per declared expiry (see interaction_limits.put). */
export const INTERACTION_EXPIRES: Record<string, string> = {
  one_day: "2027-01-02T00:00:00Z",
  three_days: "2027-01-04T00:00:00Z",
  one_week: "2027-01-08T00:00:00Z",
  one_month: "2027-02-01T00:00:00Z",
  six_months: "2027-07-01T00:00:00Z",
};

/** The org-level limit the GET reports when the override flag is set alone. */
export const INTERACTION_ORG_LIMIT = {
  limit: "existing_users",
  origin: "organization",
  expires_at: "2027-07-01T00:00:00Z",
} as const;

export const INTERACTION_ORG_CONFLICT = {
  status: 409,
  body: { message: "Conflict: an organization or user interaction limit is in effect" },
} as const;

export const CAP_UNAVAILABLE_405 = {
  status: 405,
  body: { message: "Method Not Allowed: the pull request creation cap is not available" },
} as const;

export function bypassLogins(body: unknown): string[] {
  const users = asObject(body).users;
  return Array.isArray(users) ? users.map(String) : [];
}

/** Case-insensitive login match, as GitHub treats logins. */
export function sameLogin(user: Json, login: string): boolean {
  return String(user.login).toLowerCase() === login.toLowerCase();
}

export const IMMUTABLE_OWNER_CONFLICT = {
  status: 409,
  body: { message: "Conflict: the repository owner enforces immutable releases" },
} as const;

// --- Handler-local helpers ------------------------------------------------

export function pagesUrl(slug: string): string {
  return `https://api.github.com/repos/${slug}/pages`;
}

/** 204 when enabled, 404 when not; the spec documents this 404 with NO content, so the body is empty. */
export function booleanToggleGet(enabled: boolean): MockResponse {
  return enabled ? noContent() : { status: 404, body: null };
}

function labelName(label: Json): NameKey {
  // The section's own mint, so the mock never folds a name differently than the handler does.
  return nameKey(String(label.name));
}

/** A variable's case-insensitive matching key (GitHub uppercases the match). */
export function variableName(variable: Json): string {
  // The engine's own mint, so the mock never folds a name differently than the handler does.
  return variableKey(String(variable.name ?? ""));
}

export function findLabel(state: MockState, name: string): Json | undefined {
  return state.labels.find((l) => labelName(l) === nameKey(name));
}

/**
 * Variable fields the server owns (or the update handler maps explicitly);
 * the passthrough loop must never let a payload overwrite them.
 */
const VARIABLE_CANONICAL_KEYS = new Set(["name", "value", "created_at", "updated_at"]);
/**
 * Hook fields the update handler owns (config, events, and active mapped explicitly; name and id
 * ignored); anything else in a PATCH body is a passthrough field stored verbatim.
 */
export const HOOK_CANONICAL_KEYS = new Set(["config", "events", "active", "name", "id"]);

/** The custom-pattern fields the PATCH may update (the name is immutable). */
export const SECRET_SCANNING_UPDATABLE_KEYS = [
  "pattern",
  "start_delimiter",
  "end_delimiter",
  "must_match",
  "must_not_match",
] as const;

export const SECRET_SCANNING_STALE_VERSION = {
  status: 412,
  body: { message: "Precondition Failed: the custom pattern was modified" },
} as const;

/**
 * Minted on each create and update from the per-state counter; deterministic rather than a clock, because
 * the idempotence snapshot compares state byte for byte.
 */
export function mintSecretScanningVersion(state: MockState): string {
  state._secret_scanning_version_counter += 1;
  return `v${state._secret_scanning_version_counter}`;
}

function secretScanningSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "pattern"
  );
}

/**
 * Server-owned fields over the payload's declared ones; timestamps are FIXED so repeat applies stay
 * byte-stable for the idempotence proof.
 */
export function secretScanningPatternFromCreate(state: MockState, payload: Json): Json {
  const name = String(payload.name ?? "");
  const stored: Json = {
    id: state.nextId++,
    name,
    slug: secretScanningSlug(name),
    pattern: payload.pattern ?? "",
    // ASSUMPTION, not spec: the enum documents no creation default. If real
    // GitHub lands bulk-created patterns unpublished, the created-then-clean
    // story overstates enforcement (COVERAGE documents the caveat).
    state: "published",
    push_protection_enabled: false,
    custom_pattern_version: mintSecretScanningVersion(state),
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  };
  for (const key of SECRET_SCANNING_UPDATABLE_KEYS) {
    if (payload[key] !== undefined) {
      stored[key] = payload[key];
    }
  }
  return stored;
}

/** GitHub's constant echo for a stored webhook secret, on every read. */
const HOOK_SECRET_ECHO = "********";

/**
 * GitHub keeps insecure_ssl as the STRING "0"/"1" and echoes it that way even when the write sent a
 * number; normalizing on store is what makes the section's compare-side normalization observable.
 */
export function storedHookConfig(config: Json): Json {
  if (typeof config.insecure_ssl === "number") {
    return { ...config, insecure_ssl: String(config.insecure_ssl) };
  }
  return config;
}

export function maskedConfig(config: Json): Json {
  return config.secret === undefined ? config : { ...config, secret: HOOK_SECRET_ECHO };
}

export function maskHookSecret(hook: Json): Json {
  const config = asObject(hook.config);
  return config.secret === undefined ? hook : { ...hook, config: maskedConfig(config) };
}

export function nextNumber(items: Json[]): number {
  const max = items.reduce((acc, item) => Math.max(acc, Number(item.number) || 0), 0);
  return max + 1;
}

/**
 * Mirrors GitHub's normalization (algorithm and blob, comment stripped) as an INDEPENDENT implementation,
 * not an import of the section's normalizeKeyMaterial, so a bug there surfaces as a disagreement here.
 * Sub-two-field material is stored trimmed but otherwise as-is:
 * GitHub would reject it, but the mock invents no validation the exercised scenarios do not need.
 */
export function storedKeyMaterial(key: string): string {
  const match = key.trim().match(/^(\S+)\s+(\S+)/);
  return match ? `${match[1]} ${match[2]}` : key.trim();
}

/**
 * Mock-only realism: the action passes rules through verbatim and never consults this list; it exists so
 * a typo'd rules[].type answers GitHub's real 422 shape instead of being stored silently. A lockstep test
 * (openapi/validate.test.ts) pins it to the trimmed spec's rules[].type enums.
 */
export const RULESET_RULE_TYPES = new Set([
  "creation",
  "update",
  "deletion",
  "required_linear_history",
  "merge_queue",
  "required_deployments",
  "required_signatures",
  "pull_request",
  "required_status_checks",
  "non_fast_forward",
  "commit_message_pattern",
  "commit_author_email_pattern",
  "committer_email_pattern",
  "branch_name_pattern",
  "tag_name_pattern",
  "workflows",
  "code_scanning",
  "copilot_code_review",
  "license_compliance_scanning",
  "file_path_restriction",
  "max_file_path_length",
  "file_extension_restriction",
  "max_file_size",
]);

/** GitHub's 422 for an unrecognized rules[].type, or null when all types are real. */
export function invalidRuleTypeResponse(body: unknown, docAnchor: string): MockResponse | null {
  const rules = asObject(body).rules;
  if (!Array.isArray(rules)) {
    return null;
  }
  for (const rule of rules) {
    const type = typeof rule === "object" && rule !== null ? (rule as Json).type : undefined;
    if (typeof type === "string" && !RULESET_RULE_TYPES.has(type)) {
      return {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [
            {
              resource: "RepositoryRuleset",
              code: "custom",
              field: "rules",
              message: `Invalid rule: ${type}`,
            },
          ],
          documentation_url: `https://docs.github.com/rest/repos/rules#${docAnchor}`,
        },
        requestOffSpec: true,
      };
    }
  }
  return null;
}

export interface GraphqlErrorReply {
  readonly type: GraphqlTolerableError;
  readonly message: string;
}

export type GraphqlHandlerResult =
  | { data: Json; errors?: never }
  | { errors: readonly GraphqlErrorReply[]; data?: never };

export interface GraphqlHandlerContext {
  state: MockState;
  op: TaggedGraphqlOp;
  variables: Json;
}

export type GraphqlHandler = (ctx: GraphqlHandlerContext) => GraphqlHandlerResult;

/**
 * A seeded value outside the GraphQL enum vocabulary (UPPERCASE) throws instead of folding to a default:
 * the state key looks like the settings key, so a scenario seeding the lowercase "collaborators_only"
 * would otherwise silently test against ALL. Absent fields take the fixture defaults (button off, ALL).
 */
export function repoFeatureFields(state: MockState): Json {
  const sponsorships = state.repo.has_sponsorships_enabled;
  if (sponsorships !== undefined && typeof sponsorships !== "boolean") {
    throw new Error(
      `E2E MOCK: state.repo.has_sponsorships_enabled is ${JSON.stringify(sponsorships)}; seed a boolean`,
    );
  }
  const policy = state.repo.issue_creation_policy;
  if (policy !== undefined && policy !== "ALL" && policy !== "COLLABORATORS_ONLY") {
    throw new Error(
      `E2E MOCK: state.repo.issue_creation_policy is ${JSON.stringify(policy)}; seed "ALL" or "COLLABORATORS_ONLY" (the GraphQL enum vocabulary)`,
    );
  }
  return {
    hasSponsorshipsEnabled: sponsorships === true,
    issueCreationPolicy: policy ?? "ALL",
  };
}

/**
 * The pipeline already proved the id decodes and names this repository; only the FAMILY and the
 * environment's existence are checked here. The section pins only environments it declared, with ids
 * from its own probe or PUT response, so a miss is a section bug.
 *   NOT_FOUND, declared by neither mutation  -> the response guard raises a loud violation, not a tolerated error
 */
export function pinTargetName(
  state: MockState,
  variables: Json,
): { name: string } | { errors: GraphqlErrorReply[] } {
  const decoded = decodeNodeId(String(variables.environmentId ?? ""));
  if (decoded?.family !== "environment" || !state.environments[decoded.key]) {
    return {
      errors: [
        {
          type: "NOT_FOUND",
          message: "Could not resolve to an Environment node with the given id",
        },
      ],
    };
  }
  return { name: decoded.key };
}

/**
 * Re-minted from the fixed slug, exactly what stampNodeIds stored: the ONE spelling of the repo identity
 * every GraphQL handler serves.
 */
export function repoNodeId(state: MockState): string {
  return mintNodeId("repo", state.slug, "");
}

/**
 * Completed to the spec's required shape around a PROTECTION_RULE_APPS entry; fixed timestamps for the
 * idempotence proof.
 */
export function integrationBody(app: Json): Json {
  const slug = String(app.slug);
  return {
    id: app.id,
    slug,
    node_id: mintAppNodeId(slug),
    owner: {
      login: "e2e-apps",
      id: 9100,
      node_id: "MDQ6VXNlcjkxMDA=",
      avatar_url: "https://avatars.githubusercontent.com/u/9100?v=4",
      gravatar_id: "",
      url: "https://api.github.com/users/e2e-apps",
      html_url: "https://github.com/e2e-apps",
      followers_url: "https://api.github.com/users/e2e-apps/followers",
      following_url: "https://api.github.com/users/e2e-apps/following{/other_user}",
      gists_url: "https://api.github.com/users/e2e-apps/gists{/gist_id}",
      starred_url: "https://api.github.com/users/e2e-apps/starred{/owner}{/repo}",
      subscriptions_url: "https://api.github.com/users/e2e-apps/subscriptions",
      organizations_url: "https://api.github.com/users/e2e-apps/orgs",
      repos_url: "https://api.github.com/users/e2e-apps/repos",
      events_url: "https://api.github.com/users/e2e-apps/events{/privacy}",
      received_events_url: "https://api.github.com/users/e2e-apps/received_events",
      type: "Organization",
      site_admin: false,
    },
    name: slug,
    description: null,
    external_url: String(app.integration_url ?? `https://api.github.com/apps/${slug}`),
    html_url: `https://github.com/apps/${slug}`,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    permissions: { administration: "read" },
    events: [],
  };
}
