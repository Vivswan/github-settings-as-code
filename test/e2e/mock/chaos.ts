/**
 * Fault and chaos-corruption injection: the transport-level fault barrier and
 * the response-corruption hook the pipeline (and the core-route hooks) consult
 * per request, the wire behavior each directive turns into, and the
 * construction-time validation that every injected key names a real section
 * endpoint or core route.
 */

import { ISSUE_REPORT_ENDPOINTS } from "../../../src/report/issue-report.js";
import { allEndpoints, allGraphqlOps } from "../../../src/sections/registry.js";
import type {
  CorruptOption,
  FaultOption,
  LoggedRequest,
  PipelineOptions,
  PipelineResult,
} from "./contract.js";
import type { Json, MockResponse } from "./support.js";

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

export type CoreFaultKey = keyof typeof CORE_FAULT_KEYS;

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
 * Consume one firing from a per-key `times` budget (default 1; "always" =
 * every match), counted in `counts` and mutated in place: returns the
 * pre-increment fire index, or null when the budget is spent. The ONE
 * counting rule faults and corruptions share.
 */
function takeBudgeted(
  counts: Map<string, number>,
  key: string,
  times: number | "always" | undefined,
): number | null {
  const fired = counts.get(key) ?? 0;
  const limit = times ?? 1;
  if (limit !== "always" && fired >= limit) {
    return null;
  }
  counts.set(key, fired + 1);
  return fired;
}

/**
 * Consume one firing of the fault registered for `key`, when one remains: each
 * fault fires on the first `times` (default 1; "always" = every match)
 * matching requests, counted in `faultCounts` (which doubles as the
 * fault-fired signal the server exposes). Returns the fault kind plus the
 * pre-increment fire index, which server_error uses to rotate its status
 * deterministically.
 */
export function takeFault(
  key: string,
  options: Pick<PipelineOptions, "faults" | "faultCounts">,
): { kind: FaultOption["kind"]; fired: number } | null {
  const fault = options.faults?.find((f) => f.key === key);
  if (!fault) {
    return null;
  }
  const fired = takeBudgeted(options.faultCounts, key, fault.times);
  return fired === null ? null : { kind: fault.kind, fired };
}

/**
 * Consume one chaos corruption of `key`'s response, when the directive names it
 * and its `times` budget ("always" = every match) is not spent. Shared by the
 * section pipeline and the core-route hooks so both honor the same counting.
 */
export function takeCorruption(
  key: string,
  options: Pick<PipelineOptions, "corrupt" | "corruptCounts">,
  response: MockResponse,
  log: LoggedRequest,
): PipelineResult | null {
  const corrupt = options.corrupt;
  if (!corrupt || corrupt.key !== key) {
    return null;
  }
  if (takeBudgeted(options.corruptCounts, key, corrupt.times) === null) {
    return null;
  }
  return applyCorruption(corrupt.mode, response, { ...log, status: response.status });
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
export function applyFault(
  kind: FaultOption["kind"],
  log: LoggedRequest,
  fired: number,
): PipelineResult {
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
