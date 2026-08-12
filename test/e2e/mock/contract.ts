/**
 * The request pipeline's shared vocabulary: the audit-trail log entry, the
 * chaos/fault directives a scenario can inject, the per-run mutable state,
 * the working-state union, the options the transport shell passes in, and
 * the pipeline's per-request decision. The stages that consume these live in
 * routes.ts (the pipeline), chaos.ts (fault and corruption injection),
 * core-paths.ts (the non-section routes), and server.ts (the transport).
 */

import { VIOLATION_PREFIX } from "../constants.js";
import type { Scenario } from "../schema.js";
import type { MockState, MultiMockState } from "./state.js";
import type { MockResponse } from "./support.js";

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
 * (1 + MAX_RETRIES) exhausts the retries and surfaces as a hard failure;
 * "always" faults every matching request (CorruptOption's counting), for a
 * route that must fail however often the run retries or revisits it.
 */
export interface FaultOption {
  key: string;
  kind: "rate_limit_403" | "429_then_200" | "connection_drop" | "server_error";
  times?: number | "always";
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

export function violationResponse(message: string): MockResponse {
  return { status: 400, body: { message: `${VIOLATION_PREFIX} ${message}` } };
}
