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
import { type Scenario, settingsYamlFor } from "../scenario.js";
import { assertFaultKeys } from "./chaos.js";
import {
  type CorruptOption,
  type FaultOption,
  type LoggedRequest,
  newPipelineRunState,
  type PipelineResult,
  type PipelineRunState,
  type WorkingState,
} from "./contract.js";
import { assertGraphqlHandlerCompleteness, assertHandlerCompleteness } from "./handlers.js";
import { runPipeline } from "./routes.js";
import { mockSodiumReady } from "./secrets.js";
import { buildMultiState, buildState, type MultiMockState, type MultiRepoSpec } from "./state.js";

export interface ServerOptions {
  /** GHES-style path prefix every request must carry (e.g. "/api/v3"). */
  basePrefix?: string;

  /** One chaos corruption, addressed by the same key as a fault; assertFaultKeys refuses an unknown key at construction. */
  corrupt?: CorruptOption;

  /** Transport faults by endpoint key; assertFaultKeys refuses an unknown or duplicate key at construction. */
  faults?: FaultOption[];
}

export interface MockHandle {
  /** The FULL base the runner points GITHUB_API_URL at, GHES prefix included; the runner appends nothing. */
  url: string;

  /** The live state the handlers mutate, shared with the pipeline, so a test can assert what a request stored. */
  working: WorkingState;

  /** Every request in arrival order, violations and faults included; the runner's rules match against it. */
  requests: LoggedRequest[];

  /** Mock-contract violations in arrival order; a scenario with any fails. */
  violations: string[];

  /** Live fire count per injected fault key; a key never appearing here never reached its fault hook, so the iteration proved nothing about fault handling, and fuzz and scenario consumers assert non-vacuity against it. */
  faultCounts: ReadonlyMap<string, number>;

  /**
   * One-way: the convergence re-run spawns a check-mode child against this same apply-mode server, so the runner arms
   * the barrier before the re-run to make an unexpected write a violation.
   */
  enterCheckMode(): void;

  stop(): Promise<void>;
}

/** What the request handler reads and appends per request; `checkModeOverride` is enterCheckMode()'s one-way flip. */
interface ServerRun {
  scenario: Scenario;
  working: WorkingState;
  options: ServerOptions;
  runState: PipelineRunState;
  requests: LoggedRequest[];
  violations: string[];
  checkModeOverride: boolean;
}

/** One request as the pipeline reads it: the URL parsed, the query flattened, the headers normalized, the body read. */
interface Incoming {
  url: URL;
  query: Record<string, string>;
  headers: Headers;
  body: unknown;
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

/** req.url is the path + query; the base is only for URL's parser. */
async function parseIncoming(req: IncomingMessage): Promise<Incoming> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    query[k] = v;
  }
  return { url, query, headers: headersFrom(req), body: await readBody(req) };
}

/**
 * Off-contract responses are skipped by the validator entirely. Derived from `wire` presence rather than the
 * constructor's flag, so a future wire kind cannot forget to opt out; keyed on the REQUEST media type, so every raw
 * endpoint inherits the skip. The body is cloned: handlers return live state objects and validateLog runs at scenario
 * end, so logging by reference would let a later mutation rewrite an earlier logged body.
 */
function recordResult(run: ServerRun, result: PipelineResult, headers: Headers): void {
  const rawMediaType = (headers.get("accept") ?? "").includes(".raw");
  const offSpec = result.wire !== undefined || result.offSpecBody || rawMediaType;
  result.log.offSpec = offSpec;
  result.log.responseBody = offSpec ? undefined : structuredClone(result.response.body);
  run.requests.push(result.log);
  if (result.violation) {
    run.violations.push(result.violation);
  }
}

/**
 * GitHub announces the page after this one as `Link: <url>; rel="next"`, the one header the client's walk reads. The
 * URL is the request's own, host and prefix included, with `page` advanced, so the client never composes a page URL.
 */
function nextLink(
  req: IncomingMessage,
  url: URL,
  nextPage: number | undefined,
): Record<string, string> {
  if (nextPage === undefined) {
    return {};
  }
  const next = new URL(`${url.pathname}${url.search}`, `http://${req.headers.host ?? "localhost"}`);
  next.searchParams.set("page", String(nextPage));
  return { link: `<${next.href}>; rel="next"` };
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

/**
 * A dropped connection is destroyed before any bytes leave on purpose: a flushed response head lets the client resolve
 * it, and octokit swallows the body-read failure, delivering the truncated body as a SUCCESS. The log line labels the
 * trace; nothing else of this fault is observable.
 */
function writeResult(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  result: PipelineResult,
): void {
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

  const extraHeaders = {
    ...result.response.headers,
    ...nextLink(req, url, result.response.nextPage),
  };
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
}

/**
 * A connection the CLIENT tore down mid-request (the runner killing a timed-out child) has nobody to answer.
 * `destroyed` alone is too broad: node auto-destroys a fully consumed request stream, so it is paired with !complete
 * to keep a genuine post-read handler bug loud.
 */
function isClientTeardown(req: IncomingMessage, error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    (req.destroyed && !req.complete) ||
    code === "ECONNRESET" ||
    code === "ERR_STREAM_PREMATURE_CLOSE"
  );
}

/**
 * A crash here would make every later request ECONNREFUSED and mask the real fault, and an ordinary 500 would let a
 * failure-expecting scenario pass on it, so a handling failure becomes a violation that fails the scenario loudly.
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  run: ServerRun,
): Promise<void> {
  try {
    const incoming = await parseIncoming(req);
    const result = runPipeline(
      {
        method: req.method ?? "GET",
        rawPath: incoming.url.pathname,
        query: incoming.query,
        rawQuery: incoming.url.search.replace(/^\?/, ""),
        headers: incoming.headers,
        body: incoming.body,
      },
      {
        scenario: run.scenario,
        working: run.working,
        basePrefix: run.options.basePrefix,
        corrupt: run.options.corrupt,
        faults: run.options.faults,
        ...run.runState,
        checkMode: run.scenario.inputs?.mode === "check" || run.checkModeOverride,
      },
    );
    recordResult(run, result, incoming.headers);
    writeResult(req, res, incoming.url, result);
  } catch (error) {
    if (isClientTeardown(req, error)) {
      return;
    }

    run.violations.push(
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

/** Port 0 so many scenarios run concurrently without contention. */
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
  const run: ServerRun = {
    scenario,
    working: multi
      ? { mode: "multi", multi }
      : { mode: "single", state: buildState(scenario.live_state, scenario.owner_kind) },
    options,
    runState: newPipelineRunState(),
    requests: [],
    violations: [],
    checkModeOverride: false,
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res, run);
  });

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
    working: run.working,
    requests: run.requests,
    violations: run.violations,
    faultCounts: run.runState.faultCounts,
    enterCheckMode() {
      run.checkModeOverride = true;
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
