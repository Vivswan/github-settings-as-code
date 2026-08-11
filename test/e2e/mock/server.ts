/**
 * The mock GitHub API server: one fresh Bun.serve per scenario, listening on an
 * ephemeral port. All request logic lives in routes.ts (the pure pipeline);
 * this file is the transport shell that parses the incoming Request, hands it
 * to the pipeline, records the log/violation, and serializes the response.
 *
 * The MockHandle a caller receives exposes the base URL to point the action's
 * client at, the live MockState (to seed or assert against), and the request
 * and violation logs the runner checks after the run.
 */

import { stringify as stringifyYaml } from "yaml";
import type { MultiRepo, Scenario } from "../schema.js";
import {
  assertFaultKeys,
  assertGraphqlHandlerCompleteness,
  assertHandlerCompleteness,
  type CorruptOption,
  type FaultOption,
  type LoggedRequest,
  newPipelineRunState,
  runPipeline,
  type WorkingState,
} from "./routes.js";
import { mockSodiumReady } from "./secrets.js";
import { buildMultiState, buildState, type MultiMockState, type MultiRepoSpec } from "./state.js";

/** Extra knobs beyond the scenario: the GHES prefix and the chaos directive. */
export interface ServerOptions {
  /** GHES-style path prefix every request must carry (e.g. "/api/v3"). */
  basePrefix?: string;
  /** Corrupt the first response of one endpoint, to prove loud client failure. */
  corrupt?: CorruptOption;
  /** Transport-level faults injected on the first matching requests. */
  faults?: FaultOption[];
}

/** The live server: where to reach it, its state, its logs, and how to stop. */
export interface MockHandle {
  url: string;
  /**
   * The working state, discriminated exactly as the pipeline carries it:
   * single-repo (`working.state`) XOR multi-repo (`working.multi`). Tests
   * seed or assert against the narrowed side directly.
   */
  working: WorkingState;
  requests: LoggedRequest[];
  violations: string[];
  /**
   * How many times each injected fault key actually FIRED (key -> count), live
   * over the run. A fuzz/scenario consumer asserts non-vacuity against it: an
   * injected fault whose key never appears here targeted a route the run never
   * reached, so the iteration proved nothing about fault handling.
   */
  faultCounts: ReadonlyMap<string, number>;
  /**
   * Arm the check-mode write barrier for all SUBSEQUENT requests. One-way (no
   * exit): the convergence re-run spawns a check-mode child against this same
   * already-running server, whose scenario is still apply-mode, so the runner
   * calls this before the re-run to make an unexpected write a violation.
   */
  enterCheckMode(): void;
  stop(): Promise<void>;
}

/**
 * The raw settings.yml content the contents endpoint serves for a target:
 * `settings_raw` verbatim when set (for a genuine parse failure), else the
 * settings object serialized to YAML, else null (the no-settings-file case).
 */
function settingsYamlFor(spec: MultiRepo): string | null {
  if (spec.settings_raw !== undefined) {
    return spec.settings_raw;
  }
  if (spec.settings === null || spec.settings === undefined) {
    return null;
  }
  return stringifyYaml(spec.settings);
}

/**
 * Convert a scenario's multi-repo declaration into the buildMultiState inputs:
 * each target's settings object is serialized to the raw YAML the contents
 * endpoint serves (null settings -> null, the no-file case). Discovery-pool
 * slugs and per-repo specs are unioned by buildMultiState. Returns undefined
 * for a single-repo scenario.
 */
function multiStateFor(scenario: Scenario): MultiMockState | undefined {
  if (!scenario.repos && !scenario.discovery) {
    return undefined;
  }
  const repos: Record<string, MultiRepoSpec> = {};
  for (const [slug, spec] of Object.entries(scenario.repos ?? {})) {
    repos[slug] = {
      settingsYaml: settingsYamlFor(spec),
      liveState: spec.live_state,
      permissions: spec.permissions,
    };
  }
  return buildMultiState(repos, scenario.discovery?.pool, scenario.owner_kind);
}

/**
 * Start a mock server for one scenario. The state is materialized from the
 * scenario's live_state overlay; the server listens on port 0 (an OS-assigned
 * free port) so many scenarios can run concurrently without contention. The
 * returned `url` is the FULL base the runner points GITHUB_API_URL at,
 * including the GHES prefix when the scenario opts into one - the runner
 * appends nothing. Async so a future tier (a real subprocess-backed server)
 * can await readiness without changing the signature.
 */
export async function startMockServer(
  scenario: Scenario,
  options: ServerOptions = {},
): Promise<MockHandle> {
  // Fail loudly at construction if either handler table has drifted from its
  // declaration dictionary, before any request is served.
  assertHandlerCompleteness();
  assertGraphqlHandlerCompleteness();
  // Reject fault/corrupt directives naming unknown endpoints or duplicate faults.
  assertFaultKeys(options.faults, options.corrupt);
  // libsodium init, awaited ONCE here: the secret-family PUT handlers unseal
  // synchronously (the Handler contract is synchronous by design), so the
  // WASM must be ready before the first request can arrive.
  await mockSodiumReady();

  // Multi-repo scenarios run per-slug state; single-repo scenarios keep the one
  // MockState. The discriminated `working` carries exactly one, and the
  // pipeline dispatches on its mode.
  const multi = multiStateFor(scenario);
  const working: WorkingState = multi
    ? { mode: "multi", multi }
    : { mode: "single", state: buildState(scenario.live_state, scenario.owner_kind) };
  const requests: LoggedRequest[] = [];
  const violations: string[] = [];
  // All mutable per-run pipeline state (chaos/fault counts + barrier bookkeeping)
  // from one factory, so a new field cannot be omitted at the call site below.
  const runState = newPipelineRunState();
  // One-way override flipped by enterCheckMode(); ORed with the scenario mode.
  let checkModeOverride = false;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) {
        query[k] = v;
      }
      const body = await readBody(request);

      const result = runPipeline(
        {
          method: request.method,
          rawPath: url.pathname,
          query,
          rawQuery: url.search.replace(/^\?/, ""),
          headers: request.headers,
          body,
        },
        {
          scenario,
          working,
          basePrefix: options.basePrefix,
          corrupt: options.corrupt,
          faults: options.faults,
          ...runState,
          checkMode: scenario.inputs?.mode === "check" || checkModeOverride,
        },
      );

      // Mark responses that are deliberately off the OpenAPI contract so the
      // validator skips them ENTIRELY (status and body):
      //   - ANY wire override (chaos raw text, the connection drop): derived
      //     from `wire` presence here, not the constructor's offSpecBody flag,
      //     so a future wire kind cannot forget to opt out of validation;
      //   - synthetic transport faults (rate-limit 403 / 429 / connection drop),
      //     whose statuses no per-endpoint spec lists;
      //   - any response to a request that asked for a RAW media type: the raw
      //     Accept header (e.g. the settings-file fetch) returns file TEXT, not
      //     the JSON content-object the spec documents. Keying this on the
      //     REQUEST media type - not an endpoint name - means every future raw
      //     endpoint inherits the exemption automatically.
      const rawMediaType = (request.headers.get("accept") ?? "").includes(".raw");
      const offSpec = result.wire !== undefined || result.offSpecBody || rawMediaType;
      result.log.offSpec = offSpec;
      // SNAPSHOT the body: handlers return LIVE state objects (ok(state.repo),
      // in-place Object.assigns), and validateLog runs at scenario end, so
      // logging by reference would let a later mutation retroactively rewrite an
      // earlier logged body. structuredClone freezes what was actually sent.
      result.log.responseBody = offSpec ? undefined : structuredClone(result.response.body);
      requests.push(result.log);
      if (result.violation) {
        violations.push(result.violation);
      }

      // connection_drop: Bun.serve cannot abort before the status line, so the
      // drop happens mid-response via an erroring body stream; undici surfaces
      // that as a network read failure (a real drop can occur at any phase).
      if (result.wire?.kind === "drop") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection dropped"));
            },
          }),
          { status: 500 },
        );
      }

      const status = result.response.status;
      if (result.wire?.kind === "raw") {
        // Chaos invalid_json: send the raw unparseable text verbatim.
        return new Response(result.wire.text, {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      const headers = result.response.headers;
      if (result.response.body === null || result.response.body === undefined) {
        return new Response(null, { status, ...(headers ? { headers } : {}) });
      }
      return Response.json(result.response.body, { status, ...(headers ? { headers } : {}) });
    },
  });

  // The prefix is part of the base URL the client is pointed at, so every
  // request the client makes carries it (which is exactly what the pipeline's
  // prefix check expects).
  const base = `http://localhost:${server.port}`;
  return {
    url: options.basePrefix ? `${base}${options.basePrefix}` : base,
    working,
    requests,
    violations,
    faultCounts: runState.faultCounts,
    enterCheckMode() {
      checkModeOverride = true;
    },
    async stop() {
      await server.stop(true);
    },
  };
}

/**
 * Parse the request body: JSON when the method carries one and the body is
 * non-empty, otherwise undefined. A malformed JSON body from the CLIENT (not
 * the chaos hook, which corrupts the SERVER side) is surfaced as the raw text
 * so a handler/pipeline can still log it rather than throwing here.
 */
async function readBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  const text = await request.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
