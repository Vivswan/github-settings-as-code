/**
 * The transport shell over the pure pipeline in routes.ts: one fresh node:http server per scenario on an ephemeral port.
 *
 * node:http rather than Bun.serve for one load-bearing capability: the connection_drop fault needs the raw socket to
 * destroy before any response bytes leave, a TRUE network failure the client sees as a socket error. Bun.serve's closest
 * approximation is an erroring response stream:
 *   bun 1.3.6   -> a clean empty 500
 *   bun 1.3.14  -> kills the server process outright
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type Scenario, settingsYamlFor } from "../schema.js";
import { assertFaultKeys } from "./chaos.js";
import {
  type CorruptOption,
  type FaultOption,
  type LoggedRequest,
  newPipelineRunState,
  type WorkingState,
} from "./contract.js";
import { assertGraphqlHandlerCompleteness, assertHandlerCompleteness } from "./handlers.js";
import { runPipeline } from "./routes.js";
import { mockSodiumReady } from "./secrets.js";
import { buildMultiState, buildState, type MultiMockState, type MultiRepoSpec } from "./state.js";

export interface ServerOptions {
  /** GHES-style path prefix every request must carry (e.g. "/api/v3"). */
  basePrefix?: string;
  corrupt?: CorruptOption;
  faults?: FaultOption[];
}

export interface MockHandle {
  url: string;
  working: WorkingState;
  requests: LoggedRequest[];
  violations: string[];
  /**
   * Live fire count per injected fault key. A key that never appears here never reached its fault hook, so the
   * iteration proved nothing about fault handling; fuzz and scenario consumers assert non-vacuity against it.
   */
  faultCounts: ReadonlyMap<string, number>;
  /**
   * One-way: the convergence re-run spawns a check-mode child against this same apply-mode server, so the runner arms
   * the barrier before the re-run to make an unexpected write a violation.
   */
  enterCheckMode(): void;
  stop(): Promise<void>;
}

/** A null settings object stays null: the no-file case contentsResponse answers 404 for. */
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
 * Port 0 so many scenarios run concurrently without contention. `url` is the FULL base the runner points GITHUB_API_URL
 * at, GHES prefix included; the runner appends nothing.
 */
export async function startMockServer(
  scenario: Scenario,
  options: ServerOptions = {},
): Promise<MockHandle> {
  assertHandlerCompleteness();
  assertGraphqlHandlerCompleteness();
  assertFaultKeys(options.faults, options.corrupt);
  // Awaited once here: the secret-family PUT handlers unseal synchronously, so the WASM must be ready before the first request.
  await mockSodiumReady();

  const multi = multiStateFor(scenario);
  const working: WorkingState = multi
    ? { mode: "multi", multi }
    : { mode: "single", state: buildState(scenario.live_state, scenario.owner_kind) };
  const requests: LoggedRequest[] = [];
  const violations: string[] = [];
  const runState = newPipelineRunState();
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

      // Off-contract responses are skipped by the validator entirely. Derived from `wire` presence rather than the
      // constructor's flag, so a future wire kind cannot forget to opt out; keyed on the REQUEST media type, so every
      // raw endpoint inherits the skip.
      const rawMediaType = (headers.get("accept") ?? "").includes(".raw");
      const offSpec = result.wire !== undefined || result.offSpecBody || rawMediaType;
      result.log.offSpec = offSpec;
      // Handlers return live state objects and validateLog runs at scenario end, so logging by reference would let a
      // later mutation rewrite an earlier logged body.
      result.log.responseBody = offSpec ? undefined : structuredClone(result.response.body);
      requests.push(result.log);
      if (result.violation) {
        violations.push(result.violation);
      }

      // Destroyed before any bytes leave on purpose: a flushed response head lets the client resolve it, and octokit
      // swallows the body-read failure, delivering the truncated body as a SUCCESS. The log line labels the trace;
      // nothing else of this fault is observable.
      if (result.wire?.kind === "drop") {
        console.log(
          `[mock] injecting connection drop (intentional fault, expected in passing runs) for ${req.method} ${url.pathname}`,
        );
        req.socket.destroy();
        return;
      }

      const status = result.response.status;
      if (result.wire?.kind === "raw") {
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
      // A connection the CLIENT tore down mid-request (the runner killing a timed-out child) has nobody to answer.
      // `destroyed` alone is too broad: node auto-destroys a fully consumed request stream, so it is paired with
      // !complete to keep a genuine post-read handler bug loud.
      const code = (error as NodeJS.ErrnoException).code;
      if (
        (req.destroyed && !req.complete) ||
        code === "ECONNRESET" ||
        code === "ERR_STREAM_PREMATURE_CLOSE"
      ) {
        return;
      }
      // A crash here would make every later request ECONNREFUSED and mask the real fault; an ordinary 500 would let a
      // failure-expecting scenario pass on it. A violation fails the scenario loudly.
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
      // Sever kept-alive client connections so close() cannot hang on an idle socket.
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function sendBody(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
): void {
  res.writeHead(status, { ...headers, "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

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

/** A malformed JSON body from the CLIENT surfaces as the raw text, so the pipeline can log it instead of throwing here. */
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
