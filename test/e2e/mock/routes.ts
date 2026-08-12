/**
 * The mock GitHub server's route table and request pipeline. Everything here
 * is pure logic over a MockState and a Scenario; the transport shell
 * (node:http, per-scenario lifecycle) lives in server.ts.
 *
 * The route TABLE is not hand-written: it is derived from allEndpoints(), the
 * frozen dictionary the sections themselves declare. The hand-written parts
 * live one layer down: one stateful handler per "section.role" key in the
 * section fragments (sections.ts, built on support.ts), merged into HANDLERS /
 * GRAPHQL_HANDLERS here, plus the CORE_PATHS handlers for the non-section
 * calls. A startup assertion pins the handler and endpoint sets equal in both
 * directions, so adding a section endpoint without a matching mock handler
 * (or leaving a stale handler behind) fails loudly at construction.
 */

import { isIssueChannel } from "../../../src/action/redact.js";
import { MAX_RETRIES } from "../../../src/github/api.js";
import {
  ISSUE_REPORT_ENDPOINTS,
  ISSUE_REPORT_PERMISSION,
  MARKER_LABEL,
  MARKER_LABEL_CONFIG,
} from "../../../src/report/issue-report.js";
import type { SectionKey } from "../../../src/schema.js";
import {
  endpointKind,
  endpointMethod,
  endpointPath,
  endpointPermission,
  matchesTemplate,
  type SectionPermission,
  toleratedGraphqlErrors,
  toleratedStatuses,
} from "../../../src/sections/contract.js";
import {
  allEndpoints,
  allGraphqlOps,
  SECTIONS,
  type TaggedEndpoint,
  type TaggedGraphqlOp,
} from "../../../src/sections/registry.js";
import { ADMIN_SLUG, TOKEN_USER_LOGIN, VIOLATION_PREFIX } from "../constants.js";
import { DENIAL_SEMANTICS } from "../denial-semantics.js";
import type { DenialStyle, MaskGrade, MaskKey, PermissionMask, Scenario } from "../schema.js";
import { sectionGraphqlHandlerFragments, sectionHandlerFragments } from "./sections.js";
import { decodeNodeId, type MockState, type MultiMockState, type NodeFamily } from "./state.js";
import {
  asObject,
  findLabel,
  type GraphqlErrorReply,
  type GraphqlHandler,
  type Handler,
  type Json,
  type MockResponse,
  nextNumber,
  ok,
  slicePage,
} from "./support.js";

/**
 * One logged request, the audit trail the runner asserts against. `pathname`
 * is the path only (no query string, GHES base prefix already stripped) and
 * `query` is the raw query string ("" when none), kept as separate fields: the
 * runner prefix-matches mutations/never against "METHOD pathname" and
 * substring-matches requests_contain (e.g. "page=2") against a rejoined
 * "METHOD pathname?query", so both rules hold without the mock guessing which
 * a scenario wants.
 */
export interface LoggedRequest {
  method: string;
  pathname: string;
  query: string;
  status: number;
  /** The masked resource that denied this request, when a denial fired. */
  deniedBy?: string;
  /** Parsed JSON body for writes. */
  body?: unknown;
  /**
   * The response body the mock sent, captured by server.ts once the pipeline
   * has decided. The OpenAPI validator checks it against responses[status];
   * undefined for an empty (204) body. Not set by the pipeline itself - the
   * transport shell attaches it from result.response.body after logging.
   */
  responseBody?: unknown;
  /**
   * True when this whole response is deliberately off the OpenAPI contract -
   * a raw media type (the settings-file fetch returns file text), a synthetic
   * transport fault (rate-limit 403 / 429 / connection drop), or a chaos-corrupt
   * body. The validator skips such entries entirely (status AND body): the spec
   * documents neither the status nor the shape, by design. Set by server.ts.
   */
  offSpec?: boolean;
  /**
   * True when the handler rejected a request whose BODY is deliberately off
   * the spec's request schema (a passthrough user typo, e.g. an unknown
   * rules[].type answered with GitHub's real 422). The validator skips only
   * the request-body SCHEMA check; body-presence checks and the response are
   * validated normally. Copied from MockResponse.requestOffSpec by the
   * pipeline.
   */
  requestOffSpec?: boolean;
  /**
   * The GraphQL operation behind this request, when it hit /graphql and
   * resolved to a declared operation: the dispatched operationName plus its
   * declared kind. What lets every log consumer stay exact where the HTTP
   * method cannot: the runner's write classification (a GraphQL READ is a
   * POST on the wire), the "GRAPHQL <opName>" expectation spelling, and the
   * coverage tripwire's per-operation attribution all read it. Unset for a
   * /graphql request that never resolved (a violation).
   */
  graphql?: { operationName: string; kind: "read" | "write" };
}

/** Look up a section module by key (for endpointPermission resolution). */
const SECTION_BY_KEY = new Map<SectionKey, (typeof SECTIONS)[number]>(
  SECTIONS.map((section) => [section.key, section]),
);

/**
 * The effective permission requirement of an endpoint: its resolved
 * SectionPermission (or "none") paired with whether it reads or writes. The
 * gate composes both to grade the token mask.
 */
interface Requirement {
  permission: SectionPermission | "none";
  kind: "read" | "write";
}

function endpointRequirement(endpoint: TaggedEndpoint): Requirement {
  const section = SECTION_BY_KEY.get(endpoint.section);
  if (!section) {
    throw new Error(`BUG: no section module registered for key "${endpoint.section}"`);
  }
  return { permission: endpointPermission(section, endpoint), kind: endpointKind(endpoint) };
}

// --- Permission mask grading ---------------------------------------------

const GRADE_RANK: Record<MaskGrade, number> = { none: 0, read: 1, write: 2 };

/**
 * A token permission mask: resource -> grade (see PermissionMask in
 * ../schema.ts). In single-repo mode this is the scenario's
 * token_permissions; in multi-repo mode it is the target slug's per-repo mask
 * (so a denial can be scoped to one repository).
 */

/** The grade the token holds for a mask resource; unlisted resources are write. */
function maskGrade(mask: PermissionMask, resource: MaskKey): MaskGrade {
  return mask[resource] ?? "write";
}

function grantsAtLeast(mask: PermissionMask, resource: MaskKey, needed: "read" | "write"): boolean {
  return GRADE_RANK[maskGrade(mask, resource)] >= GRADE_RANK[needed];
}

/**
 * The outcome of grading a requirement against the token mask: either allowed,
 * or denied and naming the resource that failed (logged as deniedBy). A "repo"
 * permission is satisfied by ANY listed resource meeting the grade; "org:
 * members" additionally requires org_members read. When repo access fails, the
 * denying resource is the FIRST listed repo resource (deterministic).
 */
type Grading = { allowed: true } | { allowed: false; deniedBy: MaskKey };

function gradeRequirement(mask: PermissionMask, req: Requirement): Grading {
  if (req.permission === "none") {
    return { allowed: true };
  }
  const permission = req.permission;
  const repoOk = permission.repo.some((resource) => grantsAtLeast(mask, resource, req.kind));
  if (!repoOk) {
    return { allowed: false, deniedBy: permission.repo[0] };
  }
  if (permission.org === "members" && !grantsAtLeast(mask, "org_members", "read")) {
    return { allowed: false, deniedBy: "org_members" };
  }
  return { allowed: true };
}

/**
 * Grade a bare resource+level against a mask (for non-section paths like the
 * contents fetch, which has no SectionPermission). Returns the resource as
 * deniedBy on failure, matching the section-gate's shape.
 */
function gradeResource(mask: PermissionMask, resource: MaskKey, level: "read" | "write"): Grading {
  return grantsAtLeast(mask, resource, level)
    ? { allowed: true }
    : { allowed: false, deniedBy: resource };
}

/**
 * The effective permission mask for a request: the global scenario mask
 * overlaid by the per-slug mask, per resource (per-slug wins). In single-repo
 * mode `perSlug` is undefined and the global mask stands alone; in multi-repo
 * mode a repo that names only `issues` still inherits the global grades for
 * every other resource, so the global mask is never a silent no-op.
 */
function effectiveMask(
  global: PermissionMask,
  perSlug: PermissionMask | undefined,
): PermissionMask {
  if (!perSlug) {
    return global;
  }
  return { ...global, ...perSlug };
}

// --- Denial responses -----------------------------------------------------

/**
 * The status and body a denied request answers with, by denial style and
 * read/write kind. fine_grained mirrors real fine-grained tokens (denied read
 * -> 404 Not Found, denied write -> 403 not accessible); the numeric styles
 * answer every denial uniformly. No message ever contains "rate limit", which
 * would be mistaken for throttling by the client's classifier.
 */
function denialResponse(style: DenialStyle, kind: "read" | "write"): MockResponse {
  if (style === 403) {
    return { status: 403, body: { message: "Resource not accessible by personal access token" } };
  }
  if (style === 404) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return kind === "read"
    ? { status: 404, body: { message: "Not Found" } }
    : { status: 403, body: { message: "Resource not accessible by personal access token" } };
}

/**
 * The merged per-endpoint handler tables, one entry per "section.role" key in
 * allEndpoints() / allGraphqlOps(). The entries themselves live in the section
 * fragments (sections.ts, and each moved section's src/sections/<key>/mock.ts);
 * the completeness assertions below keep the merged tables in lockstep with
 * the declarations.
 */
const HANDLERS: Record<string, Handler> = sectionHandlerFragments();
const GRAPHQL_HANDLERS: Record<string, GraphqlHandler> = sectionGraphqlHandlerFragments();

// --- Startup assertions ---------------------------------------------------

/**
 * Every allEndpoints() key MUST have a handler and every handler key MUST
 * exist in allEndpoints(), both directions. Adding a section endpoint without
 * a mock handler (or leaving a stale handler after a route is removed) fails
 * here, at server construction, instead of hiding until a scenario happens to
 * exercise that route. Exported so a unit test can assert on it directly.
 */
export function assertHandlerCompleteness(
  endpoints: Readonly<Record<string, TaggedEndpoint>> = allEndpoints(),
  handlers: Record<string, Handler> = HANDLERS,
): void {
  const endpointKeys = new Set(Object.keys(endpoints));
  const handlerKeys = new Set(Object.keys(handlers));
  const missing = [...endpointKeys].filter((key) => !handlerKeys.has(key));
  const extra = [...handlerKeys].filter((key) => !endpointKeys.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(
        `endpoints with no mock handler in the section fragments (mock/sections.ts): [${missing.sort().join(", ")}]`,
      );
    }
    if (extra.length > 0) {
      lines.push(`handlers naming no known endpoint: [${extra.sort().join(", ")}]`);
    }
    throw new Error(
      `E2E MOCK: handler table out of sync with allEndpoints()\n  ${lines.join("\n  ")}`,
    );
  }
}

/**
 * assertHandlerCompleteness for the GraphQL table: every allGraphqlOps() key
 * MUST have a handler and every handler key MUST name a declared operation,
 * both directions, asserted at server construction. Exported with injectable
 * dictionaries so a unit test can drive both failure directions.
 */
export function assertGraphqlHandlerCompleteness(
  ops: Readonly<Record<string, TaggedGraphqlOp>> = allGraphqlOps(),
  handlers: Record<string, GraphqlHandler> = GRAPHQL_HANDLERS,
): void {
  const opKeys = new Set(Object.keys(ops));
  const handlerKeys = new Set(Object.keys(handlers));
  const missing = [...opKeys].filter((key) => !handlerKeys.has(key));
  const extra = [...handlerKeys].filter((key) => !opKeys.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(
        `GraphQL operations with no mock handler in the section fragments (mock/sections.ts): [${missing.sort().join(", ")}]`,
      );
    }
    if (extra.length > 0) {
      lines.push(`GraphQL handlers naming no declared operation: [${extra.sort().join(", ")}]`);
    }
    throw new Error(
      `E2E MOCK: GraphQL handler table out of sync with allGraphqlOps()\n  ${lines.join("\n  ")}`,
    );
  }
}

/**
 * The errors[] a denied GraphQL request answers with, by denial style and
 * read/write kind - the GraphQL flavor of denialResponse, delivered inside an
 * HTTP 200 like the real endpoint. fine_grained mirrors real fine-grained
 * tokens (a denied read conceals the resource as NOT_FOUND, a denied write is
 * FORBIDDEN); the numeric styles answer uniformly with their status's type.
 * No message ever contains "rate limit" (the client's classifier reads
 * RATE_LIMITED as throttling, which a denial must never be mistaken for).
 */
export function graphqlDenialErrors(
  style: DenialStyle,
  kind: "read" | "write",
): GraphqlErrorReply[] {
  const forbidden: GraphqlErrorReply = {
    type: "FORBIDDEN",
    message: "Resource not accessible by personal access token",
  };
  const notFound: GraphqlErrorReply = {
    type: "NOT_FOUND",
    message: "Could not resolve to a Repository with the given name",
  };
  if (style === 403) {
    return [forbidden];
  }
  if (style === 404) {
    return [notFound];
  }
  return kind === "read" ? [notFound] : [forbidden];
}

/**
 * The CORE-ROUTE fault/corruption keys: stable names for the non-section paths
 * the pipeline serves inline, so a scenario (or the fuzzer) can fault the
 * discovery listing, the settings-file fetch, or the private-report issue
 * channel exactly like a section endpoint. Each fires at the same pipeline
 * point a section fault does: after route and target resolution (a fault never
 * masks an unknown-target violation) and before the permission gate. The
 * values document the route each key names; the issue-report ones are built
 * from ISSUE_REPORT_ENDPOINTS so they cannot drift from the declared routes.
 */
const CORE_FAULT_KEYS = {
  "core.discoveryList": "GET /user/repos (multi-repo discovery listing)",
  "core.contentsGet": "GET /repos/{owner}/{repo}/contents/{path} (settings-file fetch)",
  "core.userGet": `${ISSUE_REPORT_ENDPOINTS.user.route} (report fallback creator scan)`,
  "core.reportLabelCreate": `${ISSUE_REPORT_ENDPOINTS.createLabel.route} (report marker-label ensure-create)`,
  "core.issuesList": `${ISSUE_REPORT_ENDPOINTS.list.route} (report issue lookup)`,
  "core.issueCreate": `${ISSUE_REPORT_ENDPOINTS.create.route} (report issue create)`,
  "core.issuePatch": `${ISSUE_REPORT_ENDPOINTS.update.route} (report issue update)`,
} as const;

type CoreFaultKey = keyof typeof CORE_FAULT_KEYS;

/**
 * Reject fault/corrupt directives that name an unknown endpoint or duplicate a
 * fault. Keys are free-form strings, so a typo would silently never fire and a
 * duplicate fault would silently take first-match; validating at server
 * construction (the same loud-at-startup pattern as assertHandlerCompleteness)
 * turns both into an immediate throw. A key may name a section endpoint
 * ("section.role", REST or GraphQL - the two share the key space, which
 * allGraphqlOps() keeps collision-free) or a registered core route
 * (CORE_FAULT_KEYS). Exported for direct testing.
 */
export function assertFaultKeys(
  faults: FaultOption[] | undefined,
  corrupt: CorruptOption | undefined,
): void {
  const known = new Set([
    ...Object.keys(allEndpoints()),
    ...Object.keys(allGraphqlOps()),
    ...Object.keys(CORE_FAULT_KEYS),
  ]);
  const seen = new Set<string>();
  for (const fault of faults ?? []) {
    if (!known.has(fault.key)) {
      throw new Error(
        `E2E MOCK: fault names unknown endpoint "${fault.key}" (neither a section endpoint nor a core-route key)`,
      );
    }
    if (seen.has(fault.key)) {
      throw new Error(
        `E2E MOCK: duplicate fault for endpoint "${fault.key}"; keep one entry per endpoint`,
      );
    }
    seen.add(fault.key);
  }
  if (corrupt && !known.has(corrupt.key)) {
    throw new Error(
      `E2E MOCK: corrupt names unknown endpoint "${corrupt.key}" (neither a section endpoint nor a core-route key)`,
    );
  }
}

/**
 * The status-realism rule a handler must obey, and the reason it is not simply
 * "declared statuses only": a handler may answer any status the endpoint
 * DECLARES, plus any UNdeclared error status (>= 400). GitHub itself returns
 * error statuses an endpoint's happy-path docs never enumerate (a 404 for a
 * missing label on update/remove, a 409 for a conflicting create), and every
 * such error classifies through the engine's generic throwFor path, so the
 * mock modeling them is realism, not a contract break. What a handler must
 * NEVER invent is an undeclared SUCCESS/redirect (2xx/3xx): those drive the
 * section's success branches, so an undeclared one would exercise a code path
 * the endpoint declaration says cannot happen. Declaring the error status
 * instead is deliberately avoided - a declared >= 400 status feeds
 * toleratedStatuses(), so declaring e.g. 404 on labels.update would silently
 * make that error tolerated if the call site ever moved to tryCall.
 *
 * This rule governs HANDLER responses only. Transport-level faults (the fault
 * barrier's rate-limit 403 / 429, the server_error 5xx rotation, and the
 * connection_drop status 0) fire BEFORE any handler and deliberately bypass
 * this invariant: they model wire failures GitHub returns on any endpoint
 * regardless of its declared statuses.
 */
export function statusAllowed(key: string, status: number): boolean {
  return declaredStatuses(key).has(status) || status >= 400;
}

/** The declared status set for an endpoint (drives statusAllowed and tests). */
export function declaredStatuses(key: string): Set<number> {
  const endpoint = allEndpoints()[key];
  if (!endpoint) {
    throw new Error(`BUG: no endpoint "${key}"`);
  }
  return new Set(Object.keys(endpoint.statuses).map(Number));
}

// --- The request pipeline -------------------------------------------------

/**
 * A corruption directive for a named endpoint's responses. `key` is a
 * "section.role" endpoint or a CORE_FAULT_KEYS core route. `times` (default 1)
 * is how many matching responses to corrupt: 1 (the default) corrupts only the
 * first, which octokit's retry plugin transparently retries away (a parse/shape
 * fault is not a 4xx, so it is retried; MAX_RETRIES=2) - a retry-resilience
 * test. A persistent count (>= 3, more than 1 + MAX_RETRIES) or "always"
 * defeats the retries so the client fails loudly.
 */
export interface CorruptOption {
  key: string;
  mode: "invalid_json" | "wrong_shape" | "missing_envelope";
  times?: number | "always";
}

/**
 * A transport-level fault applied to the first `times` (default 1) requests
 * matching `key` (a "section.role" endpoint or a CORE_FAULT_KEYS core route).
 * Mirrors the Fault schema; the fault barrier in runPipeline (and the core-route
 * hooks) turn each kind into its wire behavior. Every kind is retried by the
 * client (throttled 403/429 via the throttling path, drops and 5xx via the retry
 * plugin), so `times: 1` is a transient the run recovers from and `times` >= 3
 * (1 + MAX_RETRIES) exhausts the retries and surfaces as a hard failure.
 */
export interface FaultOption {
  key: string;
  kind: "rate_limit_403" | "429_then_200" | "connection_drop" | "server_error";
  times?: number;
}

/**
 * Consume one firing of the fault registered for `key`, when one remains: each
 * fault fires on the first `times` (default 1) matching requests, counted in
 * `faultCounts` (which doubles as the fault-fired signal the server exposes).
 * Returns the fault kind plus the pre-increment fire index, which server_error
 * uses to rotate its status deterministically.
 */
function takeFault(
  key: string,
  options: Pick<PipelineOptions, "faults" | "faultCounts">,
): { kind: FaultOption["kind"]; fired: number } | null {
  const fault = options.faults?.find((f) => f.key === key);
  if (!fault) {
    return null;
  }
  const fired = options.faultCounts.get(key) ?? 0;
  if (fired >= (fault.times ?? 1)) {
    return null;
  }
  options.faultCounts.set(key, fired + 1);
  return { kind: fault.kind, fired };
}

/**
 * Consume one chaos corruption of `key`'s response, when the directive names it
 * and its `times` budget ("always" = every match) is not spent. Shared by the
 * section pipeline and the core-route hooks so both honor the same counting.
 */
function takeCorruption(
  key: string,
  options: Pick<PipelineOptions, "corrupt" | "corruptCounts">,
  response: MockResponse,
  log: LoggedRequest,
): PipelineResult | null {
  const corrupt = options.corrupt;
  if (!corrupt || corrupt.key !== key) {
    return null;
  }
  const done = options.corruptCounts.get(key) ?? 0;
  const limit = corrupt.times ?? 1;
  if (limit !== "always" && done >= limit) {
    return null;
  }
  options.corruptCounts.set(key, done + 1);
  return applyCorruption(corrupt.mode, response, { ...log, status: response.status });
}

/**
 * The mutable per-run state the pipeline threads through every request: the
 * chaos/fault fire counts and the two denial-barrier bookkeeping structures.
 * Grouped into one type with a single factory (`newPipelineRunState`) so a new
 * field cannot be forgotten at the construction site - adding one here without
 * adding it to the factory fails to compile, and the server spreads the factory
 * result wholesale rather than listing fields by hand.
 */
export interface PipelineRunState {
  /** Per-endpoint chaos-corruption counts, mutated in place so `times` is honored. */
  corruptCounts: Map<string, number>;
  /** Per-endpoint fault fire counts, mutated in place so `times` is honored. */
  faultCounts: Map<string, number>;
  /**
   * Target+section keys (`${slug}:${section}`, empty slug in single-repo mode)
   * whose READ was permission-denied (fatally, not tolerated) earlier this run;
   * mutated in place. The engine aborts a section at its first fatal denied
   * read, so a write arriving for the same target+section afterwards proves
   * broken sequencing (see the denial barrier). Keyed per target so one repo's
   * denied read never arms the barrier for another repo's legitimate write.
   */
  deniedReadSections: Set<string>;
  /**
   * The redaction visibility probe's window, per slug, so its denial never arms
   * the repository-section barrier while a LATER repository.get still does. The
   * probe is a `repository.get` issued during visibility resolution, before the
   * target loop. Two facts bound its window (both mutated in place):
   *   - `probeGetFaults`: how many of a slug's repository.get attempts FAULTED at
   *     the transport barrier. The probe retries a fault up to the client's
   *     budget (1 + MAX_RETRIES); once that many faults have fired, the probe has
   *     given up, so the next repository.get is a section read, not a retry.
   *   - `probeGetDelivered`: whether a repository.get for the slug has already
   *     DELIVERED a real response (granted or denied). The probe delivers at most
   *     once; any repository.get after that is the section's own check-mode read.
   * A repository.get is the probe iff a probe is expected for the slug, none has
   * delivered yet, and the fault budget is not spent - so an all-faulting probe
   * cannot keep the exemption open past its retries.
   */
  probeGetFaults: Map<string, number>;
  probeGetDelivered: Set<string>;
}

/** Fresh per-run state with every field initialized - the single construction point. */
export function newPipelineRunState(): PipelineRunState {
  return {
    corruptCounts: new Map(),
    faultCounts: new Map(),
    deniedReadSections: new Set(),
    probeGetFaults: new Map(),
    probeGetDelivered: new Set(),
  };
}

/**
 * The working state, discriminated on the run shape so exactly one store
 * exists by construction. "single" carries the one MockState every request
 * dispatches into. "multi" carries the per-slug repos + discovery pool: the
 * pipeline resolves the target slug from the request path, dispatches into
 * that slug's MockState, and grades against that slug's permission mask; the
 * `/user/repos` and `/repos/{slug}/contents/{path}` endpoints are served from
 * here. Shared by PipelineOptions and the MockHandle, so no surface can decay
 * the XOR back into two independent optionals.
 */
export type WorkingState =
  | { mode: "single"; state: MockState }
  | { mode: "multi"; multi: MultiMockState };

/** Options the server passes into the pipeline for each request. */
export interface PipelineOptions extends PipelineRunState {
  scenario: Scenario;
  working: WorkingState;
  basePrefix?: string;
  corrupt?: CorruptOption;
  /** Transport-level faults to inject on matching requests (see fault barrier). */
  faults?: FaultOption[];
  /**
   * Whether the write barrier is armed for THIS request. The server passes the
   * scenario's declared mode ORed with its one-way enterCheckMode() override,
   * so the convergence re-run (same server, check-mode child) arms the barrier
   * even though the scenario the server was built with is still apply-mode.
   */
  checkMode: boolean;
}

/** The pipeline's decision for one request: a response, a log entry, a note. */
export interface PipelineResult {
  response: MockResponse;
  log: LoggedRequest;
  /** A violation message, when the request broke the wire/route contract. */
  violation?: string;
  /**
   * How the response leaves the wire when it is NOT the normal JSON delivery
   * of `response.body` (the absent case). "raw" sends `text` verbatim (chaos
   * invalid_json, an unparseable body). "drop" makes the server destroy the
   * connection's socket before ANY response bytes leave - the connection_drop
   * fault, a true network failure the client's retries can absorb (times 1)
   * or exhaust into a hard connectivity error (times >= 1 + MAX_RETRIES). The
   * log entry still records the attempt (status 0).
   */
  wire?: { kind: "raw"; text: string } | { kind: "drop" };
  /**
   * When true, this response is a DELIBERATE off-contract body the validator
   * must skip, else it re-reports a corruption/fault the test already asserts.
   * Set for: synthetic transport faults (rate-limit 403 / 429 - GitHub returns
   * these on ANY endpoint, off any per-endpoint spec), the chaos corruptions
   * (wrong_shape / missing_envelope; invalid_json uses the "raw" wire kind),
   * and the connection_drop status-0 log. (Raw-MEDIA-TYPE bodies are exempted
   * separately in server.ts, keyed on the request's raw Accept header, not
   * this flag.)
   */
  offSpecBody?: boolean;
}

function violationResponse(message: string): MockResponse {
  return { status: 400, body: { message: `${VIOLATION_PREFIX} ${message}` } };
}

/**
 * Find the endpoint whose method and path template match this request. Returns
 * the "section.role" key, the tagged endpoint, and the named params the
 * template extracted, or null when nothing matches.
 */
function matchEndpoint(
  method: string,
  pathname: string,
): { key: string; endpoint: TaggedEndpoint; params: Record<string, string> } | null {
  for (const [key, endpoint] of Object.entries(allEndpoints())) {
    if (endpointMethod(endpoint.route) !== method) {
      continue;
    }
    const params = matchTemplateParams(endpointPath(endpoint.route), pathname);
    if (params !== null) {
      return { key, endpoint, params };
    }
  }
  return null;
}

/**
 * The named `{token}` params a route template extracts from a concrete path,
 * URL-decoded, or null when the path does not match. The SAME walk
 * matchesTemplate (src/sections/contract/endpoints.ts) proves, kept here so the match
 * proof is not thrown away: the params handlers read come from the exact
 * declaration that routed the request.
 */
function matchTemplateParams(
  template: string,
  concretePath: string,
): Record<string, string> | null {
  const templateSegs = pathSegmentsOf(template);
  const pathSegs = pathSegmentsOf(concretePath);
  if (templateSegs.length !== pathSegs.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < templateSegs.length; i++) {
    const token = templateSegs[i] as string;
    const segment = pathSegs[i] as string;
    if (token.startsWith("{") && token.endsWith("}")) {
      // A malformed percent escape (e.g. %ZZ) cannot decode to a param value;
      // treat the path as matching no route, so it fails as a loud no-route
      // violation instead of an unhandled URIError.
      try {
        params[token.slice(1, -1)] = decodeURIComponent(segment);
      } catch {
        return null;
      }
    } else if (token !== segment) {
      return null;
    }
  }
  return params;
}

/** A path's non-empty segments, query string dropped (matchesTemplate's split). */
function pathSegmentsOf(path: string): string[] {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery.split("/").filter((segment) => segment.length > 0);
}

/**
 * The HandlerContext.param accessor over one matched route's extracted
 * params: a handler asking for a `{token}` its own route never declares is a
 * mock design bug, thrown loudly with every fact needed to fix it.
 */
function paramAccessor(
  key: string,
  endpoint: TaggedEndpoint,
  params: Record<string, string>,
): (name: string) => string {
  return (name) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(
        `E2E MOCK BUG: handler "${key}" asked for path param "{${name}}" that its route "${endpoint.route}" does not declare (declared: ${Object.keys(params).join(", ") || "(none)"})`,
      );
    }
    return value;
  };
}

/**
 * The declared GraphQL operation dispatched for a request body's
 * operationName, or null when the body carries none or the name is unknown.
 * Shared by the pipeline's dispatch and sectionForRequest's attribution.
 */
function graphqlOpForBody(
  body: unknown,
  ops: Readonly<Record<string, TaggedGraphqlOp>>,
): { key: string; op: TaggedGraphqlOp } | null {
  const name = (body as { operationName?: unknown } | undefined)?.operationName;
  if (typeof name !== "string") {
    return null;
  }
  for (const [key, op] of Object.entries(ops)) {
    if (op.name === name) {
      return { key, op };
    }
  }
  return null;
}

/**
 * The section a request belongs to, or null when it matches no section
 * endpoint (core routes, unknown paths). A /graphql request attributes by its
 * body's operationName, so `body` must be supplied to resolve those. The
 * runner's apply-idempotence check uses it to attribute a second-apply write
 * to its section, so the compare-before-write subset can be held to write
 * silence.
 */
export function sectionForRequest(
  method: string,
  pathname: string,
  body?: unknown,
): SectionKey | null {
  if (pathname === "/graphql") {
    return graphqlOpForBody(body, allGraphqlOps())?.op.section ?? null;
  }
  return matchEndpoint(method, pathname)?.endpoint.section ?? null;
}

/**
 * True when a logged request mutated (or would mutate) live state. The HTTP
 * method decides for REST; for GraphQL - where every call is a POST - the
 * dispatched operation's DECLARED kind decides, so a GraphQL read never
 * counts as a write in the runner's idempotence and check-mode assertions.
 */
export function isWriteRequest(request: Pick<LoggedRequest, "method" | "graphql">): boolean {
  if (request.graphql) {
    return request.graphql.kind === "write";
  }
  return request.method !== "GET";
}

/**
 * The declared endpoint a request resolves to, or null for core/unknown
 * paths. The runner's always-rewrite check reads its `alwaysRewrite` flag,
 * so the required-rewrite set derives from the declarations - per ENDPOINT,
 * where the property lives, not per section.
 */
export function endpointForRequest(method: string, pathname: string): TaggedEndpoint | null {
  return matchEndpoint(method, pathname)?.endpoint ?? null;
}

/**
 * Handle GET /user/repos - multi-repo discovery. In single-repo mode this path
 * is never called, so it answers a loud violation; in multi-repo mode it
 * enumerates the discovery pool, applying the SERVER-SIDE query params the
 * action sends (affiliation always, visibility only for public/private) and
 * paginating, but NOT the client-side filters (archived/fork/topics/exclude),
 * which the action settles itself. The repository probe GET /repos/{o}/{r} is a
 * section endpoint (repository.get), matched before this is consulted.
 */
function handleUserRepos(
  method: string,
  pathname: string,
  query: Record<string, string>,
  multi: MultiMockState | undefined,
): { response: MockResponse; violation?: string } | null {
  if (!matchesTemplate("/user/repos", pathname)) {
    return null;
  }
  if (!multi) {
    const message = "multi-repo discovery (/user/repos) is not implemented in single-repo mode";
    return { response: violationResponse(message), violation: message };
  }
  if (method !== "GET") {
    const message = `unexpected ${method} on /user/repos`;
    return { response: violationResponse(message), violation: message };
  }
  const filtered = applyServerSideDiscovery(multi.discoveryPool, query);
  return { response: ok(slicePage(filtered, query)) };
}

/**
 * The discovery params GitHub filters SERVER-SIDE, mirrored from
 * src/discovery/discover.ts and its test. `visibility` is the only one the
 * fixtures model: the server-side query narrows only coarsely, and the action
 * settles the rest client-side, so the mock must match that split exactly:
 *   - visibility=public  -> the API returns only public repos.
 *   - visibility=private -> the API returns private AND internal repos (there
 *     is no server-side "internal" value); the action drops the internal ones
 *     client-side (discover.test.ts "visibility: private drops internal repos
 *     client-side"). So the mock must NOT drop internal on the private query.
 *   - visibility=internal / all / absent -> no server-side narrowing; the
 *     action filters, so the mock passes the pool through.
 * `affiliation` has no per-repo fixture attribute (every pool repo is treated
 * as owned), so it is a pass-through here. archived/fork/topics/exclude are
 * client-side and must NEVER be pre-filtered.
 */
function applyServerSideDiscovery(pool: Json[], query: Record<string, string>): Json[] {
  const visibility = query.visibility;
  if (visibility === "public") {
    return pool.filter((repo) => (repo.visibility ?? "public") === "public");
  }
  if (visibility === "private") {
    // Private AND internal survive the server-side query; the action narrows.
    return pool.filter((repo) => (repo.visibility ?? "public") !== "public");
  }
  return pool;
}

/**
 * The Accept header value the settings-file fetch sends: getRepoFile requests
 * the raw media type so the body comes back as the file text, not a JSON
 * content object. The mock requires this exact value on the contents route.
 */
const RAW_CONTENTS_ACCEPT = "application/vnd.github.raw+json";

/**
 * Serve a target slug's settings.yml over the contents endpoint, AFTER the
 * caller has graded the `contents` read permission. A configured slug returns
 * its raw YAML body (the client sent the raw accept header, so the body is the
 * file text verbatim); a slug whose settings are null - or one the multi-state
 * does not know - returns 404, which the action reads as "no settings file" and
 * disambiguates via the repo probe.
 */
function contentsResponse(multi: MultiMockState, slug: string): MockResponse {
  const yaml = multi.settings.get(slug);
  if (yaml === null || yaml === undefined) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return { status: 200, body: yaml };
}

/** The target slug of a contents request, or null when the path is not one. */
function contentsSlug(pathname: string): string | null {
  const match = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\//);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

// --- Private-report issue channel (core paths, not a section) --------------
//
// The issue channel delivers the full unredacted report as an issue on the
// target repo. Its routes are NOT section endpoints (report delivery is
// infrastructure that writes even in check mode); they are served inline before
// section matching, exactly like the contents fetch, and gated on the Issues
// permission per ISSUE_REPORT_PERMISSION. GET /user is the fallback creator
// scan and is a user-level call, so it is ungated (it reports TOKEN_USER_LOGIN
// from ../constants.js; the report module reads only `login`). The
// marker-label POST goes through the existing labels.create section route
// (Issues-gated, 422 on duplicate), so it is not modeled here.

/** A repo's proven visibility from its mock state (defaults public via the fixture). */
function visibilityOfState(state: MockState | undefined): string {
  const repo = state?.repo ?? {};
  if (typeof repo.visibility === "string") {
    return repo.visibility;
  }
  return repo.private === true ? "private" : "public";
}

/**
 * Whether the action could PROVE this slug's visibility - the precondition for
 * report delivery. Discovery-supplied slugs need no probe (their visibility came
 * from /user/repos), so they are always provable. An explicit target is probed
 * with one administration-gated repository.get; the probe fails to "unknown"
 * (and delivery is skipped) when administration is denied, or when a fault on
 * repository.get exhausts the probe's retry budget. Modeling this - rather than
 * reading the fixture visibility alone - is what lets the mock reject a delivery
 * the action could never have made.
 */
function probeCanProveVisibility(
  slug: string,
  scenario: Scenario,
  multi: MultiMockState | undefined,
  faults: FaultOption[] | undefined,
): boolean {
  const discovered = (multi?.discoveryPool ?? []).some(
    (repo) => String(repo.full_name).toLowerCase() === slug.toLowerCase(),
  );
  if (discovered) {
    return true;
  }
  const mask = effectiveMask(scenario.token_permissions ?? {}, multi?.permissions.get(slug));
  if (!grantsAtLeast(mask, "administration", "read")) {
    return false;
  }
  const probeFault = faults?.find((f) => f.key === "repository.get");
  if (probeFault && (probeFault.times ?? 1) >= PROBE_RETRY_BUDGET) {
    return false;
  }
  return true;
}

/**
 * Whether the scenario's report channel delivers through the target repo's
 * report issue: `issue` or `issue-on-failure` (isIssueChannel, single-sourced
 * from the action). The two differ only in WHEN they write - `issue-on-failure`
 * reads (and at most closes) on a healthy run - so the mock serves the same
 * issue routes for both and lets the recorded traffic prove the difference.
 */
function usesIssueChannel(scenario: Scenario): boolean {
  const channel = scenario.inputs?.private_report;
  return channel !== undefined && isIssueChannel(channel);
}

/**
 * Whether a slug is a report-DELIVERY target this run: the report channel is
 * an issue channel (see usesIssueChannel), redaction is on, the slug is not
 * the admin repo, its FIXTURE
 * visibility is private or internal, AND the action could actually PROVE that
 * visibility (see probeCanProveVisibility). This mirrors the action's delivery
 * rule exactly - deliver only when PROVEN private/internal, so a probe the
 * scenario denies or faults resolves "unknown" and delivery is skipped. The mock
 * serves the issue-channel routes for a slug only when this holds; report
 * traffic to any other slug (public, non-redacted, OR unknown-because-unprovable)
 * falls through to the normal barrier and section matching, so an accidental or
 * regressed delivery is caught loudly.
 */
function isReportDeliveryTarget(
  slug: string,
  scenario: Scenario,
  multi: MultiMockState | undefined,
  faults: FaultOption[] | undefined,
): boolean {
  if (!usesIssueChannel(scenario)) {
    return false;
  }
  if ((scenario.inputs?.private_repos ?? "redact") !== "redact") {
    return false;
  }
  if (slug.toLowerCase() === ADMIN_SLUG) {
    return false;
  }
  const visibility = visibilityOfState(multi ? multi.repos.get(slug) : undefined);
  if (visibility !== "private" && visibility !== "internal") {
    return false;
  }
  return probeCanProveVisibility(slug, scenario, multi, faults);
}

/** The report issue's html_url, so the run summary can link it. */
function issueUrl(slug: string, number: number): string {
  return `https://github.com/${slug}/issues/${number}`;
}

/** True when this issue object matches the list query's labels/creator/state filters. */
function issueMatchesQuery(issue: Json, query: Record<string, string>): boolean {
  if (query.state && query.state !== "all" && String(issue.state) !== query.state) {
    return false;
  }
  if (query.creator) {
    const login = (issue.user as { login?: unknown } | undefined)?.login;
    if (login !== query.creator) {
      return false;
    }
  }
  if (query.labels) {
    const wanted = query.labels.split(",");
    const have = Array.isArray(issue.labels)
      ? (issue.labels as Json[]).map((l) => String((l as { name?: unknown }).name ?? l))
      : [];
    if (!wanted.every((w) => have.includes(w))) {
      return false;
    }
  }
  return true;
}

/**
 * Expand a label name into the object shape the issues list returns. Only
 * the marker label carries its configured color (the report path is the one
 * that materializes label objects on issues); any other name gets neutral
 * filler.
 */
function labelObject(name: string): Json {
  return {
    name,
    color: name === MARKER_LABEL ? MARKER_LABEL_CONFIG.color : "ededed",
    default: false,
  };
}

/**
 * Resolve the repo state an issue-channel request addresses. An unknown slug is
 * a loud violation the caller returns early - and, matching the section
 * pipeline's unknown-target rule, it is checked BEFORE the fault hook so a
 * fault can never mask it.
 */
function resolveIssueTarget(
  method: string,
  pathname: string,
  slug: string,
  multi: MultiMockState | undefined,
  singleState: MockState | undefined,
): { state: MockState } | { response: MockResponse; violation: string } {
  const repoState = multi ? multi.repos.get(slug) : singleState;
  if (!repoState) {
    const message = `issue-report request ${method} ${pathname} names no known target slug`;
    return { response: violationResponse(message), violation: message };
  }
  return { state: repoState };
}

/**
 * Grade an issue-channel request against the report module's DECLARED
 * permission (single-sourced, so a change to ISSUE_REPORT_PERMISSION flows
 * here), not a hard-coded "issues". Returns the ready-to-send denial, or null
 * when the token is allowed.
 */
function gradeIssueAccess(
  slug: string,
  level: "read" | "write",
  scenario: Scenario,
  multi: MultiMockState | undefined,
): { response: MockResponse; deniedBy: MaskKey } | null {
  const mask = effectiveMask(scenario.token_permissions ?? {}, multi?.permissions.get(slug));
  const grading = gradeRequirement(mask, { permission: ISSUE_REPORT_PERMISSION, kind: level });
  if (!grading.allowed) {
    return { response: denialResponse(scenario.denial_style, level), deniedBy: grading.deniedBy };
  }
  return null;
}

/** The core fault key an issue route maps to, or null for an unexpected method. */
function issueRouteKey(method: string, issueNumber: number | undefined): CoreFaultKey | null {
  if (method === "GET" && issueNumber === undefined) {
    return "core.issuesList";
  }
  if (method === "POST" && issueNumber === undefined) {
    return "core.issueCreate";
  }
  if (method === "PATCH" && issueNumber !== undefined) {
    return "core.issuePatch";
  }
  return null;
}

/**
 * The issue channel's decision for one request, one branch per marker: a
 * transport fault passed through verbatim (`faulted`); a HANDLER response
 * tagged with the core route it came from (`coreKey`), so the caller can apply
 * the chaos corruption hook to it; a permission denial (`deniedBy`); or a
 * contract violation (`violation`). Denials and violations carry no coreKey
 * and are never corrupted, matching the section pipeline. Each branch declares
 * the OTHER markers `?: never` (a structural XOR, like RejectionSpec in
 * fuzz.ts): without the exclusions, the union's excess-property check would
 * accept a literal carrying two markers (any property declared on ANY member
 * is legal excess) and the consumer's first check would silently win; with
 * them, a two-marker literal fails to compile. The consumer narrows by marker
 * TRUTHINESS, which the `?: never` optionals make total - `in` checks cannot
 * narrow this shape, since an optional property never rules a member out.
 */
type IssueReportOutcome =
  | {
      faulted: PipelineResult;
      response?: never;
      coreKey?: never;
      deniedBy?: never;
      violation?: never;
    }
  | {
      response: MockResponse;
      coreKey: CoreFaultKey;
      faulted?: never;
      deniedBy?: never;
      violation?: never;
    }
  | {
      response: MockResponse;
      deniedBy: MaskKey;
      faulted?: never;
      coreKey?: never;
      violation?: never;
    }
  | {
      response: MockResponse;
      violation: string;
      faulted?: never;
      coreKey?: never;
      deniedBy?: never;
    };

/**
 * Serve the private-report issue routes against a repo's `issues` state:
 *   - GET /user                                      -> the token user (ungated)
 *   - GET  /repos/{o}/{r}/issues                      -> list (Issues: read)
 *   - POST /repos/{o}/{r}/issues                      -> create (Issues: write)
 *   - PATCH /repos/{o}/{r}/issues/{issue_number}      -> update (Issues: write)
 * Returns null when the path is not an issue-channel route, so the caller falls
 * through to section matching. Permission denials set `deniedBy` (so the
 * OpenAPI validator skips them and the runner sees the denial). `takeCoreFault`
 * is the pipeline's core-route fault hook, consulted per route after target
 * resolution and before the permission gate (the same order as the section
 * fault barrier) and before any state mutation.
 */
function handleIssueReport(
  method: string,
  pathname: string,
  query: Record<string, string>,
  body: unknown,
  scenario: Scenario,
  multi: MultiMockState | undefined,
  state: MockState | undefined,
  faults: FaultOption[] | undefined,
  takeCoreFault: (key: CoreFaultKey) => PipelineResult | null,
): IssueReportOutcome | null {
  // GET /user is the fallback creator scan - served only when the run enables
  // an issue channel at all (otherwise it is not report traffic and falls
  // through to a loud no-route violation).
  if (matchesTemplate("/user", pathname)) {
    if (method !== "GET" || !usesIssueChannel(scenario)) {
      return null;
    }
    const faulted = takeCoreFault("core.userGet");
    if (faulted) {
      return { faulted };
    }
    return {
      response: ok({ login: TOKEN_USER_LOGIN, id: 1, type: "User" }),
      coreKey: "core.userGet",
    };
  }
  // The marker-label ensure-create is report infrastructure (it writes even in
  // check mode), so it is served here - BEFORE the check-mode barrier - rather
  // than through the labels.create section route. The bypass is SCOPED: it fires
  // only for the marker label name AND only for a slug that is a report-delivery
  // target this run. A marker POST to any other slug (e.g. a buggy labels-section
  // write of the injected marker in check mode) falls through to the section
  // route and hits the normal check-mode barrier / gating.
  const labelsMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/labels$/);
  if (labelsMatch && method === "POST" && asObject(body).name === MARKER_LABEL) {
    const slug = decodeURIComponent(labelsMatch[1] ?? "");
    if (!isReportDeliveryTarget(slug, scenario, multi, faults)) {
      return null;
    }
    const resolved = resolveIssueTarget(method, pathname, slug, multi, state);
    if (!("state" in resolved)) {
      return resolved;
    }
    const faulted = takeCoreFault("core.reportLabelCreate");
    if (faulted) {
      return { faulted };
    }
    const denied = gradeIssueAccess(slug, "write", scenario, multi);
    if (denied) {
      return denied;
    }
    const coreKey = "core.reportLabelCreate" as const;
    if (findLabel(resolved.state, MARKER_LABEL)) {
      return { response: { status: 422, body: { message: "Validation Failed" } }, coreKey };
    }
    const payload = asObject(body);
    const label: Json = {
      id: resolved.state.nextId++,
      name: MARKER_LABEL,
      color: payload.color ?? "ededed",
      default: false,
      description: payload.description ?? null,
    };
    resolved.state.labels.push(label);
    return { response: { status: 201, body: label }, coreKey };
  }
  const issuesMatch = pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+))?$/);
  if (!issuesMatch) {
    return null;
  }
  const slug = decodeURIComponent(issuesMatch[1] ?? "");
  // Scope the issue-route bypass to a report-delivery target: issue traffic to a
  // public/non-redacted slug (accidental delivery) is not served here and falls
  // through to a loud no-route violation at section matching.
  if (!isReportDeliveryTarget(slug, scenario, multi, faults)) {
    return null;
  }
  const issueNumber = issuesMatch[2] ? Number(issuesMatch[2]) : undefined;
  const level: "read" | "write" = method === "GET" ? "read" : "write";
  const resolved = resolveIssueTarget(method, pathname, slug, multi, state);
  if (!("state" in resolved)) {
    return resolved;
  }
  const coreKey = issueRouteKey(method, issueNumber);
  if (coreKey) {
    const faulted = takeCoreFault(coreKey);
    if (faulted) {
      return { faulted };
    }
  }
  const denied = gradeIssueAccess(slug, level, scenario, multi);
  if (denied) {
    return denied;
  }
  const repoState = resolved.state;
  if (method === "GET" && issueNumber === undefined) {
    const matched = repoState.issues.filter((issue) => issueMatchesQuery(issue, query));
    return { response: ok(slicePage(matched, query)), coreKey: "core.issuesList" };
  }
  if (method === "POST" && issueNumber === undefined) {
    const payload = asObject(body);
    const number = nextNumber(repoState.issues);
    const labels = Array.isArray(payload.labels)
      ? payload.labels.map((l) => labelObject(String(l)))
      : [];
    const issue: Json = {
      number,
      title: payload.title ?? "",
      body: payload.body ?? "",
      state: "open",
      labels,
      user: { login: TOKEN_USER_LOGIN, id: 1, type: "User" },
      html_url: issueUrl(slug, number),
    };
    repoState.issues.push(issue);
    return { response: { status: 201, body: issue }, coreKey: "core.issueCreate" };
  }
  if (method === "PATCH" && issueNumber !== undefined) {
    const issue = repoState.issues.find((i) => Number(i.number) === issueNumber);
    if (!issue) {
      return {
        response: { status: 404, body: { message: "Not Found" } },
        coreKey: "core.issuePatch",
      };
    }
    const payload = asObject(body);
    if (payload.body !== undefined) {
      issue.body = payload.body;
    }
    if (payload.state !== undefined) {
      issue.state = payload.state;
    }
    // The marker-reattach path PATCHes a labels array (names); apply it the
    // way the create route does, so the repaired label set is observable.
    if (Array.isArray(payload.labels)) {
      issue.labels = payload.labels.map((l) => labelObject(String(l)));
    }
    return { response: ok(issue), coreKey: "core.issuePatch" };
  }
  const message = `unexpected ${method} on ${pathname}`;
  return { response: violationResponse(message), violation: message };
}

// The admin repo the e2e runner runs as (ADMIN_SLUG, its GITHUB_REPOSITORY)
// is imported from ../constants.js; the redaction self carve-out never probes
// that slug, so a repository.get for it is always a section read, never the
// probe.

/**
 * How many wire attempts the visibility probe can make: one plus the client's
 * retry budget, derived from the client's own MAX_RETRIES (src/github/api.ts).
 * Once a slug's repository.get has faulted this many times the probe has
 * exhausted its retries and given up, so the next repository.get is a section
 * read - not a probe retry - and the exemption expires.
 */
const PROBE_RETRY_BUDGET = 1 + MAX_RETRIES;

/**
 * Whether the redaction visibility probe is EXPECTED to issue a
 * `GET /repos/{slug}` for this target, so its denial may be exempted from the
 * denial barrier. The action probes a slug's visibility (one repository.get,
 * outside the section loop) only when ALL hold:
 *   - the run is multi-repo (the single-repo harness path always targets the
 *     admin repo itself, which the self carve-out never probes);
 *   - the effective policy is redact (the default; `show` never probes);
 *   - the slug is not the admin repo (the self carve-out skips the probe);
 *   - the slug's visibility did not already come from a `/user/repos` discovery
 *     response this run (a discovered slug's visibility is known, so no probe).
 * When a probe is NOT expected, the first (and only) repository.get is the
 * repository section's own check-mode read and MUST arm the barrier.
 */
function probeExpected(
  slug: string,
  scenario: Scenario,
  multi: MultiMockState | undefined,
): boolean {
  if (!multi) {
    return false;
  }
  if ((scenario.inputs?.private_repos ?? "redact") !== "redact") {
    return false;
  }
  if (slug.toLowerCase() === ADMIN_SLUG) {
    return false;
  }
  const discovered = multi.discoveryPool.some(
    (repo) => String(repo.full_name).toLowerCase() === slug.toLowerCase(),
  );
  return !discovered;
}

/**
 * The target slug a request addresses, parsed from the path. Section endpoints
 * spell it `/repos/{owner}/{repo}/...`; the team endpoints spell it as the
 * trailing `.../repos/{owner}/{repo}`; the disambiguation probe is exactly
 * `/repos/{owner}/{repo}`. Returns null when no slug is present (e.g.
 * `/orgs/{org}` alone), so the caller falls back to the admin repo's state.
 */
function slugFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  const reposIndex = segments.lastIndexOf("repos");
  if (reposIndex >= 0 && segments.length >= reposIndex + 3) {
    const owner = segments[reposIndex + 1];
    const name = segments[reposIndex + 2];
    if (owner && name) {
      return `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
    }
  }
  return null;
}

/**
 * Node-id families that are GLOBAL on GitHub (not repo-scoped): they carry
 * the GLOBAL_NODE_SLUG sentinel instead of a repository, so the mutation
 * target resolution must not read a slug off them. Apps are the one case:
 * a force-push allowance can name a GitHub App, whose id comes from the
 * repo-independent GET /apps/{app_slug} lookup.
 */
const GLOBAL_NODE_FAMILIES: ReadonlySet<NodeFamily> = new Set(["app"]);

/**
 * Every string anywhere inside a mutation's variables that decodes as a mock
 * node id, collected recursively - GraphQL mutations nest their target ids
 * under input objects, so a top-level scan would miss them. Ids of global
 * families are skipped: they name no repository.
 */
function decodedNodeIds(value: unknown, out: Array<{ slug: string }>): void {
  if (typeof value === "string") {
    const decoded = decodeNodeId(value);
    if (decoded && !GLOBAL_NODE_FAMILIES.has(decoded.family)) {
      out.push(decoded);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      decodedNodeIds(item, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      decodedNodeIds(item, out);
    }
  }
}

/**
 * Resolve a mutation's target slug from the self-describing node ids in its
 * variables: the ONE derivation of the write=>slug correlation, returning a
 * violation instead of a slug for zero or several addressed repositories
 * (the Grading-style discriminated result keeps the slug exactly where the
 * type says it is, so a write can never dispatch without a resolved target).
 */
function resolveMutationTarget(
  opName: string,
  variables: Json,
): { slug: string } | { violation: string } {
  const decoded: Array<{ slug: string }> = [];
  decodedNodeIds(variables, decoded);
  const slugs = [...new Set(decoded.map((id) => id.slug))];
  const first = slugs[0];
  if (first === undefined) {
    return {
      violation: `GraphQL mutation ${opName} carries no decodable mock node id; mutations must address their target through node ids the mock minted`,
    };
  }
  if (slugs.length > 1) {
    return {
      violation: `GraphQL mutation ${opName} carries node ids of several repositories [${slugs.sort().join(", ")}]; one mutation must address one target`,
    };
  }
  return { slug: first };
}

/**
 * Serve one POST /graphql request: the GraphQL leg of the pipeline, mirroring
 * the REST order exactly - wire shape, dispatch, check-mode barrier, target
 * resolution, fault barrier, permission gate, denial barrier, handler,
 * response guard, chaos hook.
 *
 * Target resolution is where GraphQL differs from REST (the path carries no
 * slug): a READ resolves its slug from the $owner/$repo variables the
 * declaration contract requires, and a MUTATION resolves it from the
 * self-describing node ids the mock minted (see state.ts) - an undecodable or
 * absent id is a violation, never a guess, which keeps per-slug permission
 * masks and state routing exact. Single-repo mode dispatches into the one
 * MockState like every REST endpoint.
 *
 * `ops`/`handlers` are injectable for direct testing (the
 * assertHandlerCompleteness idiom); production takes the declared tables.
 */
export function handleGraphqlRequest(
  request: { method: string; body: unknown },
  options: PipelineOptions,
  baseLog: LoggedRequest,
  ops: Readonly<Record<string, TaggedGraphqlOp>> = allGraphqlOps(),
  handlers: Record<string, GraphqlHandler> = GRAPHQL_HANDLERS,
): PipelineResult {
  const { scenario, working } = options;
  const violation = (message: string): PipelineResult => ({
    response: violationResponse(message),
    log: { ...baseLog, status: 400 },
    violation: message,
  });

  // 1. Wire shape: GraphQL is POST-only, and the client always sends the
  // query, the operationName (the dispatch key), and a variables object.
  if (request.method !== "POST") {
    return violation(`GraphQL requests must be POST, got ${request.method}`);
  }
  const body = asObject(request.body);
  if (
    typeof body.query !== "string" ||
    typeof body.operationName !== "string" ||
    typeof body.variables !== "object" ||
    body.variables === null ||
    Array.isArray(body.variables)
  ) {
    return violation(
      "GraphQL request body must carry query (string), operationName (string), and variables (object)",
    );
  }
  const variables = body.variables as Json;

  // 2. Dispatch by operationName; an unknown name is a loud violation (the
  // no-route analog).
  const dispatched = graphqlOpForBody(body, ops);
  if (!dispatched) {
    return violation(
      `no GraphQL operation named "${String(body.operationName)}" is declared by any section`,
    );
  }
  const { key, op } = dispatched;
  const graphqlLog: LoggedRequest = {
    ...baseLog,
    graphql: { operationName: op.name, kind: op.kind },
  };

  // 3. Check-mode barrier, independent of the engine's own kind-derived
  // guard: no GraphQL write may leave the client in check mode. Before the
  // fault barrier for the same reason as REST - a synthetic fault must not
  // mask the one bug this barrier exists to catch.
  if (options.checkMode && op.kind !== "read") {
    const message = `GraphQL write in check mode (${op.name})`;
    return {
      response: violationResponse(message),
      log: { ...graphqlLog, status: 400 },
      violation: message,
    };
  }

  // 4. Target/state resolution, before the fault barrier so a fault can
  // never mask an unknown-target violation. A MUTATION resolves its target
  // from the self-describing node ids in EVERY mode - single-repo included,
  // where the decoded slug must name the one state - so a section that
  // sends a garbage or foreign id can never look green against the
  // single-repo harness and only fail once a multi scenario runs it.
  // `target` is null exactly for reads; a write either resolved its slug or
  // already returned the violation.
  const target = op.kind === "write" ? resolveMutationTarget(op.name, variables) : null;
  if (target !== null && "violation" in target) {
    return violation(target.violation);
  }
  let state: MockState;
  let mask: PermissionMask = scenario.token_permissions ?? {};
  let targetSlug = "";
  if (working.mode === "single") {
    state = working.state;
    if (target !== null && target.slug !== state.slug) {
      return violation(
        `GraphQL mutation ${op.name} carries node ids of "${target.slug}", but this single-repo run serves only "${state.slug}"`,
      );
    }
  } else {
    let slug: string;
    if (target !== null) {
      slug = target.slug;
    } else {
      const { owner, repo } = variables as { owner?: unknown; repo?: unknown };
      if (typeof owner !== "string" || typeof repo !== "string") {
        return violation(
          `GraphQL read ${op.name} carries no $owner/$repo variables to resolve its target slug`,
        );
      }
      slug = `${owner}/${repo}`;
    }
    const repoState = working.multi.repos.get(slug);
    if (!repoState) {
      return violation(`GraphQL ${op.name} names no known target slug ("${slug}")`);
    }
    state = repoState;
    mask = effectiveMask(scenario.token_permissions ?? {}, working.multi.permissions.get(slug));
    targetSlug = slug;
  }

  // 5. Fault barrier: GraphQL operations are addressable by their
  // "section.role" key exactly like REST endpoints (assertFaultKeys unions
  // the two universes).
  const taken = takeFault(key, options);
  if (taken) {
    return applyFault(taken.kind, { ...graphqlLog }, taken.fired);
  }

  // 6. Permission gate, grading the operation's DECLARED kind against the
  // same mask machinery as REST. A denial is the real wire shape: HTTP 200,
  // data:null, errors[] typed per the denial style.
  const section = SECTION_BY_KEY.get(op.section);
  if (!section) {
    return violation(`BUG: no section module registered for key "${op.section}"`);
  }
  const requirement: Requirement = {
    permission: endpointPermission(section, op),
    kind: op.kind,
  };
  const grading = gradeRequirement(mask, requirement);
  if (!grading.allowed) {
    const errors = graphqlDenialErrors(scenario.denial_style, op.kind);
    const response: MockResponse = { status: 200, body: { data: null, errors } };
    const log: LoggedRequest = { ...graphqlLog, status: 200, deniedBy: grading.deniedBy };
    // 6b. Denial barrier, SHARED with REST through the same per-target
    // per-section sets: a GraphQL-read-denied section that then writes (REST
    // or GraphQL) is a violation, and vice versa. A denied read whose error
    // type the operation TOLERATES reads as "resource absent" and must not
    // arm, mirroring toleratedStatuses; advisory reads are exempt for the
    // same reason as REST.
    const barrierKey = `${targetSlug}:${op.section}`;
    let barrierViolation: string | undefined;
    if (op.kind === "read") {
      const deniedType = (errors[0] as GraphqlErrorReply).type;
      const tolerated = toleratedGraphqlErrors(op).includes(deniedType);
      if (op.advisory !== true && !tolerated) {
        options.deniedReadSections.add(barrierKey);
      }
    }
    if (op.kind === "write" && options.deniedReadSections.has(barrierKey)) {
      const semantics = DENIAL_SEMANTICS[op.section];
      barrierViolation = `write to GRAPHQL ${op.name} reached the server after a fatal denied read in the same target+section; the engine's section loop should have aborted at that read (section "${op.section}" has "${semantics}" denial semantics, style ${String(scenario.denial_style)})`;
    }
    return { response, log, violation: barrierViolation };
  }

  // 7. Handler runs.
  const handler = handlers[key];
  if (!handler) {
    // assertGraphqlHandlerCompleteness runs at construction, so this is
    // unreachable; keep it loud rather than a silent undefined call.
    return violation(`no GraphQL handler registered for dispatched operation "${key}"`);
  }
  const result = handler({ state, op, variables });

  // 8. Response guard, the status-subset analog: a handler may answer ONLY
  // data, or errors whose every type the operation declares as a tolerated
  // outcome. Anything else is a mock design bug.
  if (result.errors !== undefined) {
    const declared = toleratedGraphqlErrors(op);
    const undeclared = result.errors.filter((entry) => !declared.includes(entry.type));
    if (undeclared.length > 0) {
      return violation(
        `GraphQL handler "${key}" answered undeclared error type(s) [${undeclared.map((e) => `${e.type}: "${e.message}"`).join(", ")}]; the operation declares only [${declared.join(", ")}] as tolerated outcomes`,
      );
    }
  }
  const response: MockResponse = {
    status: 200,
    body:
      result.errors !== undefined ? { data: null, errors: result.errors } : { data: result.data },
  };

  // 9. Chaos hook, addressable by the same "section.role" key as the faults.
  const corrupted = takeCorruption(key, options, response, graphqlLog);
  if (corrupted) {
    return corrupted;
  }

  return { response, log: { ...graphqlLog, status: 200 } };
}

/**
 * Run the full request pipeline for one already-parsed request. This is pure:
 * it reads and mutates `state`, appends nothing to logs itself (the caller
 * owns the arrays), and returns the response plus the log entry and any
 * violation. The order is the contract: wire checks, prefix, route match,
 * check-mode barrier, target/state resolution, fault barrier, permission gate,
 * denial barrier, then the handler.
 */
export function runPipeline(
  request: {
    method: string;
    rawPath: string;
    query: Record<string, string>;
    rawQuery: string;
    headers: Headers;
    body: unknown;
  },
  options: PipelineOptions,
): PipelineResult {
  const { scenario, working } = options;
  // The two working-state views the shared helpers below take: multi-repo
  // routing state, and the single-repo MockState (each undefined in the other
  // mode - the discriminated `working` is the source of truth).
  const multi = working.mode === "multi" ? working.multi : undefined;
  const singleState = working.mode === "single" ? working.state : undefined;
  // The logged pathname has the GHES prefix stripped when the scenario opts
  // in; when the prefix is required but missing, there is nothing to strip, so
  // the raw path is logged with the resulting violation.
  const strippedForLog =
    options.basePrefix && request.rawPath.startsWith(options.basePrefix)
      ? request.rawPath.slice(options.basePrefix.length) || "/"
      : request.rawPath;
  const baseLog: LoggedRequest = {
    method: request.method,
    pathname: strippedForLog,
    query: request.rawQuery,
    body: request.body,
    status: 0,
  };

  // 1. Wire-contract assertions on EVERY request.
  if (!request.headers.get("authorization")) {
    const message = `request ${request.method} ${strippedForLog} is missing the Authorization header`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }
  if (!request.headers.get("x-github-api-version")) {
    const message = `request ${request.method} ${strippedForLog} is missing the x-github-api-version header`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }

  // 2. Optional GHES path prefix (e.g. /api/v3): strip before matching.
  let pathname = request.rawPath;
  if (options.basePrefix) {
    if (!pathname.startsWith(options.basePrefix)) {
      const message = `request path "${pathname}" is missing the required base prefix "${options.basePrefix}"`;
      return {
        response: violationResponse(message),
        log: { ...baseLog, status: 400 },
        violation: message,
      };
    }
    pathname = pathname.slice(options.basePrefix.length) || "/";
  }

  // The core-route fault hook: consume a registered core fault for this request
  // and turn it into its wire behavior. Built once here so every core handler
  // fires against the same per-run counts the section fault barrier uses.
  const takeCoreFault = (coreKey: CoreFaultKey): PipelineResult | null => {
    const taken = takeFault(coreKey, options);
    return taken ? applyFault(taken.kind, { ...baseLog }, taken.fired) : null;
  };

  // 3a. Multi-repo discovery: /user/repos is not a section endpoint and is not
  // per-slug permission-gated (it is a user-level call), so it is served before
  // route matching. Its fault/corruption hooks fire only on the legit route
  // (never masking a violation), mirroring the section pipeline's order.
  const userRepos = handleUserRepos(request.method, pathname, request.query, multi);
  if (userRepos) {
    if (!userRepos.violation) {
      const faulted = takeCoreFault("core.discoveryList");
      if (faulted) {
        return faulted;
      }
      const corrupted = takeCorruption("core.discoveryList", options, userRepos.response, baseLog);
      if (corrupted) {
        return corrupted;
      }
    }
    return {
      response: userRepos.response,
      log: { ...baseLog, status: userRepos.response.status },
      violation: userRepos.violation,
    };
  }

  // 3b. The settings-file fetch (contents). Not a section endpoint, but it IS
  // permission-gated (Contents: read) and method/Accept-constrained, so it runs
  // through the same gate as a section read: GET only, the raw Accept header
  // required, and a Contents-denied slug gets the read-denial response (which
  // drives the action's 404 disambiguation + "grant Contents: read" advice).
  const cSlug = contentsSlug(pathname);
  if (cSlug !== null) {
    if (!multi) {
      const message = "settings-file fetch (contents) is not implemented in single-repo mode";
      return {
        response: violationResponse(message),
        log: { ...baseLog, status: 400 },
        violation: message,
      };
    }
    if (request.method !== "GET") {
      const message = `contents fetch must be GET, got ${request.method}`;
      return {
        response: violationResponse(message),
        log: { ...baseLog, status: 400 },
        violation: message,
      };
    }
    if (request.headers.get("accept") !== RAW_CONTENTS_ACCEPT) {
      const message = `contents fetch must send Accept: ${RAW_CONTENTS_ACCEPT}, got "${request.headers.get("accept") ?? ""}"`;
      return {
        response: violationResponse(message),
        log: { ...baseLog, status: 400 },
        violation: message,
      };
    }
    // Resolve the target BEFORE the fault hook, the same order the section
    // barrier and the issue-report routes use: a request addressing an unknown
    // slug keeps its plain not-found answer and must never consume (steal) a
    // fault injected for the legitimate target. For a KNOWN target the fault
    // fires before the permission gate (a wire failure happens regardless of
    // permissions), and always after the mode/method/Accept violations above,
    // which stay unmaskable.
    const knownTarget = multi.repos.has(cSlug);
    if (knownTarget) {
      const contentsFault = takeCoreFault("core.contentsGet");
      if (contentsFault) {
        return contentsFault;
      }
    }
    const mask = effectiveMask(scenario.token_permissions ?? {}, multi.permissions.get(cSlug));
    const grading = gradeResource(mask, "contents", "read");
    if (!grading.allowed) {
      const response = denialResponse(scenario.denial_style, "read");
      return { response, log: { ...baseLog, status: response.status, deniedBy: grading.deniedBy } };
    }
    const response = contentsResponse(multi, cSlug);
    if (knownTarget) {
      const corrupted = takeCorruption("core.contentsGet", options, response, baseLog);
      if (corrupted) {
        return corrupted;
      }
    }
    // The raw settings-file body skips response-body validation, but that is
    // decided by the request's raw Accept media type in server.ts (so every
    // raw endpoint inherits it), not marked here per-endpoint.
    return { response, log: { ...baseLog, status: response.status } };
  }

  // 3b2. Private-report issue channel (GET /user, the issues list/create/patch).
  // Served inline, before section matching, because report delivery is
  // infrastructure that writes even in check mode - so it must NOT pass through
  // the check-mode write barrier below. Gated on the Issues permission. The
  // handler consults the core-route fault hook per route; a handler response
  // comes back tagged with its core key so the chaos hook can corrupt it.
  const issueReport = handleIssueReport(
    request.method,
    pathname,
    request.query,
    request.body,
    scenario,
    multi,
    singleState,
    options.faults,
    takeCoreFault,
  );
  if (issueReport) {
    if (issueReport.faulted) {
      return issueReport.faulted;
    }
    if (issueReport.coreKey) {
      const corrupted = takeCorruption(issueReport.coreKey, options, issueReport.response, baseLog);
      if (corrupted) {
        return corrupted;
      }
    }
    return {
      response: issueReport.response,
      log: {
        ...baseLog,
        status: issueReport.response.status,
        ...(issueReport.deniedBy ? { deniedBy: issueReport.deniedBy } : {}),
      },
      ...(issueReport.violation ? { violation: issueReport.violation } : {}),
    };
  }

  // 3b3. GraphQL operations: one path, dispatched by operationName, served
  // BEFORE REST endpoint matching (no path template can claim /graphql).
  if (pathname === "/graphql") {
    return handleGraphqlRequest({ method: request.method, body: request.body }, options, baseLog);
  }

  // 3c. Section endpoints.
  const matched = matchEndpoint(request.method, pathname);
  if (!matched) {
    const message = `no route in routes.ts for ${request.method} ${pathname}`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }
  const { key, endpoint } = matched;

  // Check-mode barrier: no writes may leave the client in check mode. This runs
  // BEFORE the fault barrier so a faulted write in check mode is still caught as
  // a violation - the engine must never send a write in check mode, which is
  // the exact case this barrier exists to catch, and a synthetic fault must not
  // mask it. The flag is the scenario's mode ORed with the server's one-way
  // override, so a convergence re-run against the same server arms it too.
  if (options.checkMode && request.method !== "GET") {
    const message = `write in check mode: ${request.method} ${pathname} (endpoint "${key}")`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }

  // Resolve the working state and permission mask for this request. In
  // single-repo mode both come from the one MockState and the scenario mask; in
  // multi-repo mode the routing depends on whether the endpoint is repo-scoped:
  //   - a repo endpoint (path starts /repos/) selects the target slug's
  //     MockState and grades against that slug's per-slug mask overlaid on the
  //     global mask (a denial can be scoped to one repository);
  //   - an org endpoint (the teams /orgs/{org} probe) is NOT per-slug: it reads
  //     the shared org state and grades against the GLOBAL mask. A team-repo
  //     route (/orgs/{org}/teams/.../repos/{owner}/{repo}) still carries a repo
  //     tail, so it resolves to the addressed slug's state, but org endpoints
  //     never get a per-slug mask.
  let state: MockState;
  let mask: PermissionMask = scenario.token_permissions ?? {};
  // The target slug for keying the per-target denied-read barrier ("" in
  // single-repo mode). Set inside the multi arm below.
  let targetSlug = "";
  switch (working.mode) {
    case "single": {
      state = working.state;
      break;
    }
    case "multi": {
      const repoScoped = endpointPath(endpoint.route).startsWith("/repos/");
      const slug = slugFromPath(pathname);
      const repoState = slug ? working.multi.repos.get(slug) : undefined;
      if (repoScoped) {
        if (!slug || !repoState) {
          const message = `multi-repo request ${request.method} ${pathname} names no known target slug`;
          return {
            response: violationResponse(message),
            log: { ...baseLog, status: 400 },
            violation: message,
          };
        }
        state = repoState;
        mask = effectiveMask(scenario.token_permissions ?? {}, working.multi.permissions.get(slug));
        targetSlug = slug;
      } else {
        // Org endpoint. A team-repo route carries a {owner}/{repo} tail: it MUST
        // resolve to that slug's state, so an unknown slug is the same violation
        // the repo-scoped branch raises (falling back to orgState would let a
        // buggy write silently mutate shared org state). Only the BARE org probe
        // (no slug in the path, e.g. GET /orgs/{org}) uses orgState.
        if (slug && !repoState) {
          const message = `multi-repo request ${request.method} ${pathname} names no known target slug`;
          return {
            response: violationResponse(message),
            log: { ...baseLog, status: 400 },
            violation: message,
          };
        }
        state = repoState ?? working.multi.orgState;
        targetSlug = slug ?? "";
        // HYBRID grading for a team-repo route: real GitHub treats administration
        // as a REPOSITORY permission on the ADDRESSED repo (fine-grained PATs
        // grant it per selected repo - adding a repo to a team needs admin on
        // that repo), while org_members is org-wide. So the repo resources grade
        // against the addressed slug's effective per-slug mask and org_members
        // against the GLOBAL mask. This matches the oracle's orgMask model by
        // construction. The bare org probe (no slug) has no repo resources and is
        // permission-none anyway, so the global mask stands.
        const global = scenario.token_permissions ?? {};
        if (slug) {
          mask = {
            ...effectiveMask(global, working.multi.permissions.get(slug)),
            org_members: global.org_members,
          };
        } else {
          mask = global;
        }
      }
      break;
    }
  }

  // Identify the redaction visibility probe so its denial never arms the
  // repository-section barrier. The exemption is bounded to the probe's window
  // (see probeGetFaults/probeGetDelivered): a repository.get is the probe iff a
  // probe is EXPECTED for the slug, no repository.get has DELIVERED yet, and the
  // probe's fault-retry budget is not spent. This is computed after the fault
  // barrier (below) against the pre-delivery state, so an all-faulting probe
  // cannot keep the exemption open past its retries.

  // Fault barrier: transport-level failures fire before the permission gate and
  // handler (a rate limit / drop happens at the wire regardless of permissions),
  // but AFTER target/state resolution so a fault can never mask the
  // unknown-target violation - that check is a harness-integrity invariant and
  // must be unmaskable. Each fault applies to the first `times` (default 1)
  // requests matching its endpoint key.
  const taken = takeFault(key, options);
  if (taken) {
    // A faulted probe attempt counts toward its retry budget so the exemption
    // cannot outlast the probe's own retries (an all-faulting probe gives up,
    // and the next repository.get is a section read that must arm).
    if (key === "repository.get") {
      options.probeGetFaults.set(targetSlug, (options.probeGetFaults.get(targetSlug) ?? 0) + 1);
    }
    return applyFault(taken.kind, { ...baseLog }, taken.fired);
  }

  // Past the fault barrier a real response WILL be delivered. Decide whether this
  // repository.get is the probe (against the pre-delivery state), THEN record the
  // delivery so any later repository.get for the slug is a section read.
  const isVisibilityProbe =
    key === "repository.get" &&
    probeExpected(targetSlug, scenario, multi) &&
    !options.probeGetDelivered.has(targetSlug) &&
    (options.probeGetFaults.get(targetSlug) ?? 0) < PROBE_RETRY_BUDGET;
  if (key === "repository.get") {
    options.probeGetDelivered.add(targetSlug);
  }

  // 4. Permission gate.
  const requirement = endpointRequirement(endpoint);
  const grading = gradeRequirement(mask, requirement);
  if (!grading.allowed) {
    const response = denialResponse(scenario.denial_style, requirement.kind);
    const log: LoggedRequest = { ...baseLog, status: response.status, deniedBy: grading.deniedBy };
    // 5. Denial barrier. A denied write is a hard VIOLATION only when a fatal
    // denied READ in the SAME target+section already happened this run: the
    // engine reads a section before diffing/writing, so once its read is denied
    // and classified as fatal, the section loop aborts - a later write reaching
    // the server proves broken sequencing. This is the ONLY signal. Preflight is
    // deliberately NOT used as a separate guarantee: preflight (fail policy)
    // only proves READS work - the engine's probe wrapper stops writes
    // client-side - so a mask graded READ (write denied) on a "denied"-semantics
    // section PASSES preflight, and the engine then legitimately sends the first
    // write. That write is denied but is NOT a violation; the old
    // "denied-semantics && fail => violation" branch false-flagged exactly this
    // case. When the read grade is `none` the denied read always precedes the
    // write and arms the set, so no coverage is lost by relying on it alone.
    //
    // The set is keyed per TARGET (`${slug}:${section}`, empty slug single-repo)
    // so one repo's denied read never arms the barrier for another repo's
    // legitimate write.
    const barrierKey = `${targetSlug}:${endpoint.section}`;
    let violation: string | undefined;
    if (requirement.kind === "read") {
      // Track the denied read ONLY when the engine perceives it as a failure:
      // a denial status the endpoint tolerates (a fine_grained 404 on a
      // probeAbsent-tolerant endpoint) reads as "resource absent" and the
      // section legitimately proceeds, so it must not arm the barrier.
      //
      // Two categories are EXEMPT because their denied read is not a
      // section-abort read:
      //   - the redaction visibility probe (isVisibilityProbe): the FIRST
      //     repository.get for a repo, issued before the target loop to decide
      //     redaction. A LATER repository.get (the section's check-mode read) is
      //     not the probe and arms like any other section read.
      //   - an ADVISORY read (endpoint.advisory, single-sourced from the endpoint
      //     declaration, e.g. branches.branchProbe): the engine ignores any
      //     non-404 status and proceeds to its write anyway, so a denied advisory
      //     read does not mean the section should have aborted.
      // Genuine denied-read-then-write coverage is preserved: every non-advisory
      // section read still arms.
      const exempt = isVisibilityProbe || endpoint.advisory === true;
      if (!exempt && !toleratedStatuses(endpoint).includes(response.status)) {
        options.deniedReadSections.add(barrierKey);
      }
    }
    if (requirement.kind === "write" && options.deniedReadSections.has(barrierKey)) {
      const semantics = DENIAL_SEMANTICS[endpoint.section];
      violation = `write to ${request.method} ${pathname} reached the server after a fatal denied read in the same target+section; the engine's section loop should have aborted at that read (section "${endpoint.section}" has "${semantics}" denial semantics, style ${String(scenario.denial_style)})`;
    }
    return { response, log, violation };
  }

  // 7. Handler runs.
  const handler = HANDLERS[key];
  if (!handler) {
    // assertHandlerCompleteness runs at construction, so this is unreachable;
    // keep it a loud violation rather than a silent undefined call.
    const message = `no handler registered for matched endpoint "${key}"`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }
  const response = handler({
    state,
    endpoint,
    param: paramAccessor(key, endpoint, matched.params),
    query: request.query,
    body: request.body,
  });

  // Structural status-subset guard: a handler may only answer a status the
  // endpoint declares or an undeclared error (>= 400); an undeclared 2xx/3xx is
  // a mock design bug (see statusAllowed). Asserting it here - right after the
  // handler, before the chaos hook (which deliberately produces off-contract
  // responses) - makes the invariant hold on EVERY request, not just the ones a
  // curated test happens to drive.
  if (!statusAllowed(key, response.status)) {
    const message = `handler "${key}" returned status ${response.status}, which is neither declared [${[...declaredStatuses(key)].join(", ")}] nor a >= 400 error`;
    return {
      response: violationResponse(message),
      log: { ...baseLog, status: 400 },
      violation: message,
    };
  }

  // 9. Chaos hook: corrupt the response of the named endpoint for its first
  // `times` matches ("always" = every match). Default 1 preserves the one-shot
  // behavior octokit's retry plugin transparently recovers from.
  const corrupted = takeCorruption(key, options, response, baseLog);
  if (corrupted) {
    return corrupted;
  }

  return {
    response,
    log: {
      ...baseLog,
      status: response.status,
      ...(response.requestOffSpec ? { requestOffSpec: true } : {}),
    },
  };
}

/**
 * The 5xx statuses a server_error fault rotates through, indexed by the fault's
 * fire count - deterministic, so a replayed seed sees the same statuses in the
 * same order.
 */
const SERVER_ERROR_ROTATION = [500, 502, 503] as const;

/**
 * Turn a fault kind into its wire behavior:
 *   - rate_limit_403: 403 with "rate limit" in the message, so the client's
 *     classifier reads it as throttling (isRateLimitError), NOT a permission
 *     denial. This is the one place a 403 body is ALLOWED to say "rate limit".
 *   - 429_then_200: the REAL secondary-rate-limit wire shape - the documented
 *     "secondary rate limit" message body plus a small positive Retry-After.
 *     Both details are load-bearing for production parity: octokit's
 *     throttling plugin (production's ONLY 429 recovery path; the retry
 *     plugin's doNotRetry includes 429 there) retries a 429 only when the
 *     error message contains "secondary rate", and it honors Retry-After only
 *     when POSITIVE (a 0 is falsy and falls back to the plugin's 60s default).
 *     A bare 429 + Retry-After: 0 matches neither throttle branch and would
 *     fail immediately in production while the RETRY_BASE_MS test path
 *     absorbed it in e2e.
 *   - server_error: a 5xx with a JSON message body, rotating 500/502/503 on the
 *     fault's fire count (`fired`). The client's retry plugin retries 5xx, so a
 *     single firing is retried away and `times` >= 3 exhausts the retries.
 *   - connection_drop: signal the server to destroy the socket before any
 *     response bytes leave, a true network failure the client's fetch rejects
 *     on and its retry plugin retries.
 * The log records the attempt; the fault status (403/429/5xx) or 0 (drop) is
 * set. All are deliberately off the OpenAPI contract (offSpecBody).
 */
function applyFault(kind: FaultOption["kind"], log: LoggedRequest, fired: number): PipelineResult {
  if (kind === "rate_limit_403") {
    const response: MockResponse = {
      status: 403,
      body: { message: "API rate limit exceeded for this token" },
    };
    return { response, log: { ...log, status: 403 }, offSpecBody: true };
  }
  if (kind === "429_then_200") {
    const response: MockResponse = {
      status: 429,
      body: {
        message:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        documentation_url:
          "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits",
      },
      headers: { "retry-after": "1" },
    };
    return { response, log: { ...log, status: 429 }, offSpecBody: true };
  }
  if (kind === "server_error") {
    const status = SERVER_ERROR_ROTATION[fired % SERVER_ERROR_ROTATION.length] as number;
    const response: MockResponse = { status, body: { message: "Server Error" } };
    return { response, log: { ...log, status }, offSpecBody: true };
  }
  // connection_drop
  return {
    response: { status: 0, body: null },
    log: { ...log, status: 0 },
    wire: { kind: "drop" },
    offSpecBody: true,
  };
}

/**
 * Corrupt a response per the chaos mode: invalid_json emits an unparseable
 * body (the "raw" wire kind), wrong_shape replaces a list/object body with a
 * scalar, and missing_envelope strips the wrapper key from an enveloped list.
 * All three are DELIBERATE off-contract bodies, so each marks offSpecBody
 * (invalid_json via the raw wire kind, the others explicitly) - the validator
 * must skip them, else it re-reports the corruption the chaos test already
 * asserts. The mock's own status-subset invariant still guards real handler
 * statuses.
 */
function applyCorruption(
  mode: CorruptOption["mode"],
  response: MockResponse,
  log: LoggedRequest,
): PipelineResult {
  if (mode === "invalid_json") {
    return {
      response: { status: response.status, body: undefined },
      log,
      wire: { kind: "raw", text: "{ this is not json" },
    };
  }
  if (mode === "wrong_shape") {
    return { response: { status: response.status, body: 42 }, log, offSpecBody: true };
  }
  // missing_envelope: unwrap a {total_count, <key>: []} body to a bare object
  // (drops the list the client expects behind the envelope key).
  const body = response.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const stripped: Json = {};
    for (const [entryKey, value] of Object.entries(body as Json)) {
      if (!Array.isArray(value)) {
        stripped[entryKey] = value;
      }
    }
    return { response: { status: response.status, body: stripped }, log, offSpecBody: true };
  }
  return { response: { status: response.status, body: {} }, log, offSpecBody: true };
}
