/**
 * Shared building blocks for the mock's per-endpoint handlers: the handler
 * and reply types, the reply helpers, and the handler-local helpers the
 * section handler fragments compose. This module sits BELOW the pipeline
 * (routes.ts) and the section fragments (sections.ts, and later each
 * src/sections/<key>/mock.ts): it imports neither, so a per-section mock
 * fragment can depend on it without pulling the whole pipeline in.
 */

import type { SectionKey } from "../../../src/schema.js";
import type { GraphqlTolerableError } from "../../../src/sections/contract.js";
import type {
  SectionEndpointKey,
  SectionGraphqlKey,
  TaggedEndpoint,
  TaggedGraphqlOp,
} from "../../../src/sections/registry.js";
import { decodeNodeId, mintAppNodeId, mintNodeId } from "./node-id.js";
import { MOCK_SECRETS_KEY_ID, secretDigest, unsealSecretValue } from "./secrets.js";
import type { MockState } from "./state.js";

/** A plain JSON object body. */
export type Json = Record<string, unknown>;

/** The reply a handler (or the pipeline) produces: a status and a JSON body. */
export interface MockResponse {
  status: number;
  body: unknown;
  /** Extra response headers (e.g. Retry-After on the 429 fault). */
  headers?: Record<string, string>;
  /**
   * When true, this response REJECTS a request whose body is deliberately off
   * the spec's request schema - settings pass through to the API verbatim, so
   * scenarios send user typos the schema forbids (an unknown rules[].type) and
   * the handler answers GitHub's real 4xx. The OpenAPI validator skips only
   * the request-body SCHEMA check for such requests (the rejection is the
   * behavior under test); body-presence checks and response validation still
   * apply.
   */
  requestOffSpec?: boolean;
}

/**
 * Everything a handler needs to serve one request: the mutable state, the
 * matched endpoint, the concrete path, the named path params the route
 * template extracted, the parsed query, and the request body. The
 * chaos-corruption directive is applied by the pipeline AFTER the handler
 * returns, so it is not passed here.
 */
interface HandlerContext {
  state: MockState;
  endpoint: TaggedEndpoint;
  /**
   * The URL-decoded value of one `{token}` in the matched route template
   * ({owner} and {repo} included). Extraction and routing share one template
   * walk, so a handler reads a param by the name its own ENDPOINTS
   * declaration spells and can never disagree with it about position; asking
   * for a token the route does not declare throws a mock BUG naming the
   * handler, the route, and the declared tokens. The raw path is deliberately
   * NOT exposed, so a handler cannot fall back to positional parsing.
   */
  param(name: string): string;
  query: Record<string, string>;
  body: unknown;
}

export type Handler = (ctx: HandlerContext) => MockResponse;

/**
 * One section's REST mock fragment: exactly one handler per declared
 * endpoint role. The Record over the section's exact SectionEndpointKey<K>
 * union makes both halves of handler completeness a compile-time fact for
 * the fragment - a declared endpoint without a handler is a missing
 * property, a handler naming no declared endpoint an excess one.
 */
export type SectionRestHandlers<K extends SectionKey> = Readonly<
  Record<SectionEndpointKey<K>, Handler>
>;

/** The GraphQL sibling of SectionRestHandlers, over SectionGraphqlKey<K>. */
export type SectionGraphqlHandlers<K extends SectionKey> = Readonly<
  Record<SectionGraphqlKey<K>, GraphqlHandler>
>;

// --- Pagination -----------------------------------------------------------

/**
 * Slice a full list the way src/github/paginate.ts asks for it: the client
 * sends per_page (100, or the endpoint's declared smaller pageSize) and
 * page=N, stopping when a chunk is shorter than requested. `cap`, when
 * given, is the endpoint's own documented maximum: GitHub clamps an
 * oversized per_page rather than honoring it, so a capped endpoint serves
 * at most `cap` items per page no matter what the client asks - mirroring
 * that here is what keeps the mock's paging indistinguishable from
 * GitHub's. A page past the end yields an empty slice, which ends the
 * client's loop.
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

/** A 200 JSON reply. */
export function ok(body: unknown): MockResponse {
  return { status: 200, body };
}

/** A 204 empty reply (the client normalizes an empty body to null). */
export function noContent(): MockResponse {
  return { status: 204, body: null };
}

/**
 * True when an environment exists AND its stored deployment_branch_policy
 * enables custom_branch_policies - the precondition every branch-policy
 * pattern endpoint shares (they answer 404 otherwise, like GitHub).
 */
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
 * The bare organization probe (GET /orgs/{org}) that teams and
 * custom_properties both declare: 200 with the org body, 404 on a personal
 * account. ONE handler registered under both keys, so the two cannot drift.
 * matchEndpoint resolves the shared route to the FIRST declaring section
 * (teams), so the custom_properties registration exists for the
 * completeness assertion.
 */
export const orgProbeHandler: Handler = ({ state }) => {
  if (state.org === null) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return ok(state.org);
};

/**
 * The deterministic timestamp the Nth secret PUT against a state carries:
 * every write moves updated_at, exactly like GitHub, without the mock ever
 * reading a real clock. One counter per state, shared by EVERY secret
 * family - the stamps only need to move monotonically per write, and one
 * source keeps a mixed-family scenario's ordering deterministic.
 */
function secretWriteStamp(writeCount: number): string {
  return new Date(Date.UTC(2020, 0, 15, 0, 0, writeCount)).toISOString().replace(".000Z", "Z");
}

/** A secret family's enveloped list page: names and timestamps, never values. */
export function secretsList(list: Json[], query: Record<string, string>): MockResponse {
  return ok({ total_count: list.length, secrets: slicePage(list, query) });
}

/**
 * The sealed PUT every secret family shares. This is the crypto proof: it
 * UNSEALS the uploaded ciphertext with the fixed test keypair - verifying
 * the client's key decode, sealed-box construction, and base64 round-trip in
 * one step - and stores the name plus a deterministic digest of the unsealed
 * value, never the plaintext. Every PUT bumps updated_at via the per-state
 * write counter, so the idempotence snapshot's volatile-field exclusion is
 * exercised for real. 201 on create, 204 on update, matching GitHub.
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
    // The ciphertext does not open against the advertised public key: a
    // client-side sealing bug. GitHub would store the garbage; the mock
    // rejects it loudly instead, so a broken sealing path can never pass.
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
    return noContent(); // 204: updated
  }
  list.push({ name, created_at: stamp, updated_at: stamp });
  return { status: 201, body: {} };
}

/** The DELETE every secret family shares: drop the item and its digest. */
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

/** The 409 GitHub answers when an org/user-level limit overrides the repo's. */
export const INTERACTION_ORG_CONFLICT = {
  status: 409,
  body: { message: "Conflict: an organization or user interaction limit is in effect" },
} as const;

/** The 405 both creation-cap endpoints answer where the cap is unavailable. */
export const CAP_UNAVAILABLE_405 = {
  status: 405,
  body: { message: "Method Not Allowed: the pull request creation cap is not available" },
} as const;

/** The logins a bypass-list PUT/DELETE body names ({users: [logins]}). */
export function bypassLogins(body: unknown): string[] {
  const users = asObject(body).users;
  return Array.isArray(users) ? users.map(String) : [];
}

/** Case-insensitive login match, as GitHub treats logins. */
export function sameLogin(user: Json, login: string): boolean {
  return String(user.login).toLowerCase() === login.toLowerCase();
}

/** The 409 both immutable-releases writes answer under owner enforcement. */
export const IMMUTABLE_OWNER_CONFLICT = {
  status: 409,
  body: { message: "Conflict: the repository owner enforces immutable releases" },
} as const;

// --- Handler-local helpers ------------------------------------------------

/** The Pages API url a served Pages body carries, named for the OWNING repo. */
export function pagesUrl(slug: string): string {
  return `https://api.github.com/repos/${slug}/pages`;
}

/**
 * A GET on a 204/404 boolean toggle (vulnerability-alerts): 204 when enabled,
 * 404 when not. The spec documents this 404 with NO content, so the body is
 * empty.
 */
export function booleanToggleGet(enabled: boolean): MockResponse {
  return enabled ? noContent() : { status: 404, body: null };
}

export function labelName(label: Json): string {
  return String(label.name).toLowerCase();
}

/** A variable's case-insensitive matching key (GitHub uppercases the match). */
export function environmentVariableName(variable: Json): string {
  return String(variable.name).toUpperCase();
}

/**
 * Label fields the server owns (or the update handler maps explicitly); the
 * passthrough loop must never let a payload overwrite them.
 */
export const LABEL_CANONICAL_KEYS = new Set([
  "new_name",
  "name",
  "color",
  "description",
  "id",
  "node_id",
  "url",
  "default",
]);

export function findLabel(state: MockState, name: string): Json | undefined {
  return state.labels.find((l) => labelName(l) === name.toLowerCase());
}

/** The uppercase stored name for a variables create payload. */
export function variableName(payload: Json): string {
  return String(payload.name ?? "").toUpperCase();
}

/**
 * Variable fields the server owns (or the update handler maps explicitly);
 * the passthrough loop must never let a payload overwrite them.
 */
export const VARIABLE_CANONICAL_KEYS = new Set(["name", "value", "created_at", "updated_at"]);
/**
 * Hook fields the update handler maps explicitly; anything else in a general
 * PATCH body is a passthrough field stored verbatim.
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

/** The 412 both versioned custom-pattern writes answer on a stale version. */
export const SECRET_SCANNING_STALE_VERSION = {
  status: 412,
  body: { message: "Precondition Failed: the custom pattern was modified" },
} as const;

/**
 * A fresh custom_pattern_version, minted on EVERY mutation from the
 * per-state counter - deterministic (the idempotence snapshot compares
 * state byte for byte), never a clock.
 */
export function mintSecretScanningVersion(state: MockState): string {
  state._secret_scanning_version_counter += 1;
  return `v${state._secret_scanning_version_counter}`;
}

/** A URL-friendly slug derived from a pattern name, like GitHub's. */
function secretScanningSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "pattern"
  );
}

/**
 * The stored GET shape for one bulk-create entry: server-owned fields
 * (id, slug, the "published" state, push protection off, a fresh version,
 * fixed timestamps) over the payload's declared fields. Timestamps are
 * FIXED so repeat applies stay byte-stable for the idempotence proof.
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
 * The stored form of a webhook config: GitHub keeps insecure_ssl as the
 * STRING "0"/"1" and echoes it that way even when the write sent a number,
 * so the mock normalizes on store - which is exactly what makes the
 * section's compare-side normalization observable.
 */
export function storedHookConfig(config: Json): Json {
  if (typeof config.insecure_ssl === "number") {
    return { ...config, insecure_ssl: String(config.insecure_ssl) };
  }
  return config;
}

/** A webhook config copy with any stored secret replaced by GitHub's echo. */
export function maskedConfig(config: Json): Json {
  return config.secret === undefined ? config : { ...config, secret: HOOK_SECRET_ECHO };
}

/** A response-side hook copy whose config.secret is masked (state keeps the real one). */
export function maskHookSecret(hook: Json): Json {
  const config = asObject(hook.config);
  return config.secret === undefined ? hook : { ...hook, config: maskedConfig(config) };
}

/** The next 1-based `number` for a list keyed by a numeric `number` field. */
export function nextNumber(items: Json[]): number {
  const max = items.reduce((acc, item) => Math.max(acc, Number(item.number) || 0), 0);
  return max + 1;
}

/**
 * The deploy key material GitHub stores: the algorithm and base64 blob, with
 * any trailing comment stripped. Mirrors GitHub's normalization so a
 * converging e2e apply proves the section compares normalized material - and
 * is deliberately an INDEPENDENT implementation, not an import of the
 * section's normalizeKeyMaterial, so a bug there surfaces as a disagreement
 * here instead of hiding (the oracle's globMatches pattern). Sub-two-field
 * material is stored as-is; GitHub would reject it, but the mock never
 * invents validation the exercised scenarios do not need.
 */
export function storedKeyMaterial(key: string): string {
  const match = key.trim().match(/^(\S+)\s+(\S+)/);
  return match ? `${match[1]} ${match[2]}` : key.trim();
}

/**
 * The rule types GitHub's rulesets API accepts, as its docs list them.
 * Mock-only realism: the action passes rules through verbatim by design and
 * never consults this list; it exists so a typo'd rules[].type answers
 * GitHub's real 422 shape (errors[] plus documentation_url) instead of being
 * stored silently. Pinned to the trimmed OpenAPI spec's rules[].type enums by
 * a lockstep test, so it cannot drift from the contract the validator checks.
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

/** One GraphQL errors[] entry a handler (or the denial gate) may emit. */
export interface GraphqlErrorReply {
  readonly type: GraphqlTolerableError;
  readonly message: string;
}

/**
 * A GraphQL handler's reply: data XOR errors, the structural exclusion making
 * a two-marker literal fail to compile (the IssueReportOutcome idiom).
 */
export type GraphqlHandlerResult =
  | { data: Json; errors?: never }
  | { errors: readonly GraphqlErrorReply[]; data?: never };

/** Everything a GraphQL handler needs: the target state, its op, the variables. */
export interface GraphqlHandlerContext {
  state: MockState;
  op: TaggedGraphqlOp;
  variables: Json;
}

export type GraphqlHandler = (ctx: GraphqlHandlerContext) => GraphqlHandlerResult;

/**
 * The GraphQL-only feature fields as the Repository object serves them. The
 * state fields carry the GraphQL enum vocabulary (UPPERCASE), and a seeded
 * value outside it throws instead of folding to a default: the state key
 * looks like the settings key, so a scenario seeding the lowercase
 * "collaborators_only" would otherwise silently test against ALL. Absent
 * fields take the fixture defaults (button off, policy ALL).
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
 * Resolve a pin mutation's target environment from its $environmentId. The
 * pipeline already proved the id decodes and names this repository; what is
 * checked here is the FAMILY and the environment's existence. The section
 * only mutates pins of environments it just PUT, so a non-environment id or
 * a missing environment is a section bug - answered with NOT_FOUND, which
 * neither mutation declares as an outcome, so the response guard turns it
 * into a loud violation instead of a silently tolerated error.
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
 * The repo's canonical minted node id, re-minted from the state's fixed slug
 * (exactly what stampNodeIds stored at build): the ONE spelling of the repo
 * identity every GraphQL handler serves.
 */
export function repoNodeId(state: MockState): string {
  return mintNodeId("repo", state.slug, "");
}

/**
 * The full integration (GitHub App) body the app-by-slug lookup serves,
 * completed to the spec's required shape around a PROTECTION_RULE_APPS
 * roster entry. Deterministic (fixed timestamps) for the idempotence proof.
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
