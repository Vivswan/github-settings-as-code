/** The request pipeline's shared vocabulary; routes.ts, chaos.ts, core-paths.ts, and server.ts consume it. */

import { VIOLATION_PREFIX } from "../constants.js";
import type { Scenario } from "../schema.js";
import type { MockState, MultiMockState } from "./state.js";
import type { MockResponse } from "./support.js";

/**
 * One logged request, the audit trail the runner asserts against. `pathname` and `query` stay separate fields because
 * the runner's two rules read different spellings: mutations/never prefix-match "METHOD pathname", requests_contain
 * substring-matches "METHOD pathname?query".
 */
export interface LoggedRequest {
  method: string;
  pathname: string;
  query: string;
  status: number;
  /** The masked resource that denied this request, when a denial fired. */
  deniedBy?: string;
  body?: unknown;
  /** Attached by server.ts, not the pipeline, for the OpenAPI validator; unset for an off-spec response. */
  responseBody?: unknown;
  /**
   * Set by server.ts when the whole response is deliberately off the OpenAPI contract (a raw media type, a transport
   * fault, a chaos body); the validator skips status AND body.
   */
  offSpec?: boolean;
  /**
   * The handler rejected a body deliberately off the request schema (a passthrough user typo answered with GitHub's real
   * 422); the validator skips only the request-body SCHEMA check. Copied from MockResponse.requestOffSpec.
   */
  requestOffSpec?: boolean;
  /**
   * Set when a /graphql request resolved to a declared operation. Where the HTTP method cannot be exact (a GraphQL read
   * is a POST) consumers read this: the runner's write classification, the "GRAPHQL <opName>" spelling, the coverage tripwire.
   */
  graphql?: { operationName: string; kind: "read" | "write" };
}

/**
 * `times` bounds how many matching responses are corrupted; "always" leaves no clean response for the client to recover
 * with. test/e2e/fuzz.ts drives the one-shot and persistent cases on labels.list.
 */
export interface CorruptOption {
  key: string;
  mode: "invalid_json" | "wrong_shape" | "missing_envelope";
  times?: number | "always";
}

/**
 * `times` is the recovery budget: 1 is a transient the client's retries absorb, and 1 + MAX_RETRIES faults every attempt,
 * a hard failure. rate_limit_403 is the exception: a primary rate limit is fatal on its first firing whatever the budget.
 */
export interface FaultOption {
  key: string;
  kind: "rate_limit_403" | "429_then_200" | "connection_drop" | "server_error";
  times?: number | "always";
}

/** One factory (newPipelineRunState) so a field added here without its initializer fails to compile; server.ts spreads the result wholesale. */
export interface PipelineRunState {
  /** Per-endpoint chaos-corruption counts, mutated in place so `times` is honored. */
  corruptCounts: Map<string, number>;
  /** Per-endpoint fault fire counts, mutated in place so `times` is honored. */
  faultCounts: Map<string, number>;
  /**
   * Keys whose read was fatally denied this run, per target so one repo's denial never arms another repo's write. The
   * engine aborts a section at its first fatal denied read, so a later write for the same key proves broken sequencing.
   */
  deniedReadSections: Set<string>;
  /**
   * Per slug, the repository.get attempts that faulted at the transport barrier. The probe retries up to 1 + MAX_RETRIES
   * of them; routes.ts bounds the probe's denial-barrier exemption with this count.
   */
  probeGetFaults: Map<string, number>;
  /**
   * Slugs whose repository.get delivered a real response. The probe delivers at most once, so any later repository.get
   * is not the probe and arms the barrier normally.
   */
  probeGetDelivered: Set<string>;
}

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
 * Discriminated so exactly one store exists by construction; shared by PipelineOptions and the MockHandle, so no surface
 * can decay the XOR back into two independent optionals.
 */
export type WorkingState =
  | { mode: "single"; state: MockState }
  | { mode: "multi"; multi: MultiMockState };

export interface PipelineOptions extends PipelineRunState {
  scenario: Scenario;
  working: WorkingState;
  basePrefix?: string;
  corrupt?: CorruptOption;
  faults?: FaultOption[];
  /**
   * The scenario's mode ORed with the server's one-way enterCheckMode() override, so the convergence re-run (same
   * server, check-mode child) arms the barrier although the scenario is still apply-mode.
   */
  checkMode: boolean;
}

export interface PipelineResult {
  response: MockResponse;
  log: LoggedRequest;
  violation?: string;
  /**
   * "drop" destroys the socket before any response bytes leave: a true network failure the client's retries absorb
   * (times 1) or exhaust into a hard connectivity error. The log still records the attempt with status 0.
   */
  wire?: { kind: "raw"; text: string } | { kind: "drop" };
  /**
   * A deliberate off-contract body the validator must skip, else it re-reports a fault the test already asserts.
   * Raw-media-type bodies are exempted separately in server.ts, keyed on the request's Accept header, not this flag.
   */
  offSpecBody?: boolean;
}

export function violationResponse(message: string): MockResponse {
  return { status: 400, body: { message: `${VIOLATION_PREFIX} ${message}` } };
}

/** Closed over one base log so no stage hand-rolls a drifting copy. */
export function violationFor(baseLog: LoggedRequest): (message: string) => PipelineResult {
  return (message) => ({
    response: violationResponse(message),
    log: { ...baseLog, status: 400 },
    violation: message,
  });
}

/**
 * The one rendering every log consumer (the runner, the apply-idempotence proof) matches against. A GraphQL request
 * renders as "GRAPHQL <opName>": every GraphQL call shares POST /graphql, so the operation name is the only spelling that
 * pins one operation.
 */
export function renderRequest(request: LoggedRequest, includeQuery: boolean): string {
  if (request.graphql) {
    return `GRAPHQL ${request.graphql.operationName}`;
  }
  const base = `${request.method} ${request.pathname}`;
  return includeQuery && request.query ? `${base}?${request.query}` : base;
}
