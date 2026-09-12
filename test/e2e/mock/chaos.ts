/** Fault and chaos-corruption injection; a scenario addresses a section endpoint or an inline core route by the same key. */

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
 * Stable keys so a scenario or the fuzzer faults an inline route like a section endpoint, at the same pipeline point
 * (after target resolution, before the permission gate). The issue-report values derive from ISSUE_REPORT_ENDPOINTS so
 * they cannot drift from the declared routes.
 */
const CORE_FAULT_KEYS = {
  "core.discoveryList": "GET /user/repos (multi-repo discovery listing)",
  "core.contentsGet": "GET /repos/{owner}/{repo}/contents/{path} (settings-file fetch)",
  "core.reportLabelCreate": `${ISSUE_REPORT_ENDPOINTS.createLabel.route} (report marker-label ensure-create)`,
  "core.issuesList": `${ISSUE_REPORT_ENDPOINTS.list.route} (report issue lookup)`,
  "core.issueCreate": `${ISSUE_REPORT_ENDPOINTS.create.route} (report issue create)`,
  "core.issuePatch": `${ISSUE_REPORT_ENDPOINTS.update.route} (report issue update)`,
} as const;

export type CoreFaultKey = keyof typeof CORE_FAULT_KEYS;

/**
 * Keys are free-form strings: a typo would silently never fire and a duplicate fault would silently take first-match, so
 * both throw at server construction. REST and GraphQL share the key space, which allGraphqlOps() keeps collision-free.
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

/** The ONE counting rule faults and corruptions share; the returned index is the pre-increment fire count. */
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

/** faultCounts doubles as the fault-fired signal the server exposes; the fire index lets server_error rotate its status deterministically. */
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

/** Shared by the section pipeline and the core-route hooks so both honor the same `times` counting. */
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

/** Indexed by fire count, so a replayed seed sees the same statuses in the same order. */
const SERVER_ERROR_ROTATION = [500, 502, 503] as const;

/**
 * Every kind is deliberately off the OpenAPI contract (offSpecBody). The client's retry plugin retries 5xx and drops, so
 * one firing is retried away and `times` >= 3 exhausts the retries.
 */
export function applyFault(
  kind: FaultOption["kind"],
  log: LoggedRequest,
  fired: number,
): PipelineResult {
  if (kind === "rate_limit_403") {
    // "rate limit" in the body is what makes the client's classifier (isRateLimitError) read this 403 as throttling,
    // not a permission denial: the one place a 403 body may say it.
    const response: MockResponse = {
      status: 403,
      body: { message: "API rate limit exceeded for this token" },
    };
    return { response, log: { ...log, status: 403 }, offSpecBody: true };
  }
  if (kind === "429_then_200") {
    // Production's ONLY 429 recovery is octokit's throttling plugin (the retry plugin's doNotRetry includes 429): a 429
    // without the "secondary rate" phrase or a zero-quota header is not retried, and Retry-After counts only when
    // POSITIVE (0 is falsy and falls back to its 60s default). Both details are load-bearing for parity with production.
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
  // connection_drop: server.ts destroys the socket before any bytes leave, a true network failure the client's fetch rejects on.
  return {
    response: { status: 0, body: null },
    log: { ...log, status: 0 },
    wire: { kind: "drop" },
    offSpecBody: true,
  };
}

/**
 * All three are deliberate off-contract bodies the validator must skip (invalid_json through the raw wire kind, the
 * others through offSpecBody), else it re-reports the corruption the chaos test already asserts.
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
