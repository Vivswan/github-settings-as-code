/**
 * The mock GitHub API server: one fresh node:http server per scenario,
 * listening on an ephemeral port. All request logic lives in routes.ts (the
 * pure pipeline); this file is the transport shell that parses the incoming
 * request, hands it to the pipeline, records the log/violation, and serializes
 * the response.
 *
 * node:http (which bun implements) rather than Bun.serve, for one load-bearing
 * capability: the connection_drop fault needs the raw socket so it can destroy
 * the connection before any response bytes leave - a TRUE network failure the
 * client sees as a socket error, which Bun.serve's fetch-shaped handler cannot
 * produce (its closest approximation, an erroring response stream, delivered a
 * clean empty 500 under bun 1.3.6 and kills the server process outright under
 * 1.3.14).
 *
 * The MockHandle a caller receives exposes the base URL to point the action's
 * client at, the live MockState (to seed or assert against), and the request
 * and violation logs the runner checks after the run.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
 * appends nothing. Async because the caller must not see the handle before
 * the listener is bound (the port is OS-assigned).
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

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // req.url is the path + query; the base is only for URL's parser.
      const url = new URL(req.url ?? "/", "http://localhost");
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) {
        query[k] = v;
      }
      const headers = headersFrom(req);
      const body = await readBody(req);

      const result = runPipeline(
        {
          method: req.method ?? "GET",
          rawPath: url.pathname,
          query,
          rawQuery: url.search.replace(/^\?/, ""),
          headers,
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
      const rawMediaType = (headers.get("accept") ?? "").includes(".raw");
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

      // connection_drop: destroy the raw socket before ANY response bytes
      // leave - no status line, no headers. The client sees a genuine
      // socket-level network failure (undici rejects the fetch itself), which
      // its retry machinery treats as retryable; a fault budget that outlasts
      // the retries surfaces as a hard connectivity failure. Destroying
      // pre-response is deliberate: bytes flushed before the destroy would
      // let the client resolve the response head and then silently deliver
      // the truncated (here: empty) body as a SUCCESS - octokit swallows the
      // body-read failure - so a mid-body drop would not fail at all, let
      // alone retry. The intent line labels the trace; nothing else of this
      // fault is observable in-process.
      if (result.wire?.kind === "drop") {
        console.log(
          `[mock] injecting connection drop (intentional fault, expected in passing runs) for ${req.method} ${url.pathname}`,
        );
        req.socket.destroy();
        return;
      }

      const status = result.response.status;
      if (result.wire?.kind === "raw") {
        // Chaos invalid_json: send the raw unparseable text verbatim.
        sendBody(res, status, { "content-type": "application/json" }, result.wire.text);
        return;
      }
      const extraHeaders = result.response.headers ?? {};
      if (result.response.body === null || result.response.body === undefined) {
        res.writeHead(status, extraHeaders);
        res.end();
        return;
      }
      sendBody(
        res,
        status,
        { "content-type": "application/json", ...extraHeaders },
        JSON.stringify(result.response.body),
      );
    } catch (error) {
      // A connection the CLIENT tore down mid-request (the runner killing a
      // timed-out child) is not a mock bug: there is nobody to answer and
      // nothing to report. `destroyed` alone is too broad - node auto-destroys
      // a fully-consumed request stream, so it must be paired with !complete
      // (the read was cut short) to keep a genuine post-read handler bug loud.
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (req.destroyed && !req.complete) ||
        code === "ECONNRESET" ||
        code === "ERR_STREAM_PREMATURE_CLOSE"
      ) {
        return;
      }
      // A pipeline/serialization bug must not kill the server process (every
      // later scenario request would see ECONNREFUSED and mask the real
      // fault) - but it must not hide behind an ordinary 500 either (a
      // scenario expecting failure would pass on it), so it is recorded as a
      // violation, which fails the scenario loudly.
      violations.push(
        `mock request handling failed for ${req.method} ${req.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      console.error("[mock] request handling failed:", error);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  }

  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("BUG: mock server has no bound TCP port");
  }

  // The prefix is part of the base URL the client is pointed at, so every
  // request the client makes carries it (which is exactly what the pipeline's
  // prefix check expects).
  const base = `http://localhost:${address.port}`;
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
      // Force-close like Bun.serve's stop(true): sever kept-alive client
      // connections so the close callback cannot hang on an idle socket.
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** Write one complete response with an explicit Content-Length. */
function sendBody(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
): void {
  res.writeHead(status, { ...headers, "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

/** The incoming node header map as the case-insensitive Headers the pipeline reads. */
function headersFrom(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * Parse the request body: JSON when the method carries one and the body is
 * non-empty, otherwise undefined. A malformed JSON body from the CLIENT (not
 * the chaos hook, which corrupts the SERVER side) is surfaced as the raw text
 * so a handler/pipeline can still log it rather than throwing here.
 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
