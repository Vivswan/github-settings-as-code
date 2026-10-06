/**
 * The GitHubClient port and its one implementation, GitHubApi, on @octokit/core with the request-log, retry,
 * throttling, and paginate-rest plugins; what a failed request becomes is api-error.ts's, and what a trace line may
 * show is trace-redaction.ts's. A payload's JSON body is its own serialization (redactSecretPayloadSafe), never an
 * endpoint typing that could drop an unknown field.
 */

import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { requestLog } from "@octokit/plugin-request-log";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { EndpointOptions, RequestInterface } from "@octokit/types";
import type Bottleneck from "bottleneck/light.js";
import { maskRegistry } from "../io.js";
import { isPlainObject } from "../plain-data.js";
import {
  type ApiError,
  apiErrorFromGraphqlErrors,
  apiErrorFromHttp,
  isHttpError,
  type OctokitHttpError,
  REDACTED_RESPONSE_WITHHELD,
  REDACTED_TRANSPORT_WITHHELD,
  SECRET_TRANSPORT_WITHHELD,
  transportFailure,
  transportReason,
  withheld,
} from "./api-error.js";
import {
  IMMEDIATE_SCHEDULER,
  type Scheduler,
  type ThrottleGroups,
  TIMERS_SCHEDULER,
  throttleGroups,
} from "./scheduler.js";
import { redactSecretPayloadSafe } from "./secret-scan.js";
import {
  redactingOctokitLog,
  repoSlugOf,
  type TraceIo,
  TraceRedaction,
} from "./trace-redaction.js";

/**
 * The single source for the header default here, the action.yml `api-version` default, and the inputs fallback; the
 * action-yml contract test asserts the three stay equal.
 */
export const DEFAULT_API_VERSION = "2022-11-28";

/**
 * `kind` is declared explicitly, NEVER derived from the POST method every GraphQL call shares. This module must not
 * import from sections/, so GraphqlOpDecl extends this shape structurally.
 */
export interface GraphqlOp {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly query: string;
}

/**
 * `carriesSecret` marks a request whose payload or variables hold a resolved secret. The engine sets it from the act of
 * resolving (engine/execute.ts) and withholds the request's error on its own side of this port whatever the client
 * answers (sections/contract/requests.ts), so a caller-supplied client cannot leak an echoed value into an outcome or
 * a report; GitHubApi honors the mark too, beside its field-name scan, for its direct callers.
 */
export interface RequestMark {
  carriesSecret?: boolean;
}

/**
 * What one request ends in. `error` is GitHub's answer, classified by status. `failed` is the whole line for a request
 * with no HTTP answer to classify: not sent (its payload is not plain data), the transport failed once the retries
 * were spent, or a GraphQL body broke the wire contract; its reason is already withheld where the mark or the trace
 * redaction demands. The client never throws for either.
 */
export type ClientAnswer<D> = { data: D } | { error: ApiError } | { failed: string };

/** The page size every list walk asks GitHub for, GitHub's documented maximum, unless the endpoint caps lower. */
export const PAGE_SIZE = 100;

export interface ListOptions {
  /** Items per page; PAGE_SIZE when omitted. An endpoint with a documented cap below it passes the cap. */
  perPage?: number | undefined;
  /** Ends the walk after the first page this accepts, for a scan that needs only the newest page carrying a match. */
  until?: (page: unknown) => boolean;
}

export interface GitHubClient {
  /**
   * `redactTrace` holds the request's `/repos/<owner>/<repo>` slug redacted for the request's duration, for the
   * visibility probe, which must not leak the slug before it knows whether the repository is private.
   */
  tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: RequestMark & { accept?: string; raw?: boolean; redactTrace?: boolean },
  ): Promise<ClientAnswer<unknown>>;
  /**
   * One GET list walk: `data` carries every page's body in order, each as GitHub sent it (a bare list, or the
   * `{total_count, <key>: []}` envelope), so the caller selects the list by its key. The walk ends where GitHub's
   * pagination ends, or after the page `until` accepts; the first page it cannot fetch is the whole answer.
   */
  tryList(path: string, options?: ListOptions): Promise<ClientAnswer<unknown[]>>;
  /**
   * Failures, including the errors[] GitHub delivers inside an HTTP 200, come back as the same ApiError the REST
   * classifiers read. `slug` names the owner/repo: GraphQL carries the target in the request BODY, invisible to the
   * URL-based trace redaction.
   */
  tryGraphql(
    op: GraphqlOp,
    variables: Readonly<Record<string, unknown>>,
    slug: string,
    options?: RequestMark,
  ): Promise<ClientAnswer<Record<string, unknown>>>;
}

/** The primary and secondary limits are handled identically but for the log `label`, so one factory keeps them from drifting. */
function throttleCallback(
  label: string,
  trace: TraceRedaction,
): (
  retryAfter: number,
  options: { method: string; url: string },
  octokit: unknown,
  retryCount: number,
) => boolean {
  return (retryAfter, options, _octokit, retryCount) => {
    trace.debug(
      `${label} on ${options.method} ${trace.path(options.url).path}; retry ${retryCount + 1}/${MAX_RETRIES} after ${retryAfter}s`,
    );
    return retryAfter <= MAX_RETRY_WAIT_S && retryCount < MAX_RETRIES;
  };
}

// Failing loudly with the API message beats stalling a workflow for an hour. Exported so the docs contradiction test
// pins the semantics guide's number to this value.
export const MAX_RETRY_WAIT_S = 60;
// Exported so the test harness builds its retry budgets (1 + MAX_RETRIES) from the one real value, and the docs
// contradiction test pins the guide's retry count to it.
export const MAX_RETRIES = 2;

// The request-log plugin stays: its per-attempt trace line carries GitHub's request id, which support asks for.
const ActionOctokit = Octokit.plugin(requestLog, retry, throttling, paginateRest);

/** GSAC_RETRY_BASE_MS is the one knob the e2e runner sets: millisecond plugin units and the immediate scheduler for the spawned bundle. */
function envRetryBaseMs(): number | undefined {
  const value = Number(process.env.GSAC_RETRY_BASE_MS ?? "");
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Among the 4xx only 408 is retried here; 429 and the rate-limit 403s belong to the throttling plugin, which honors Retry-After. */
const DO_NOT_RETRY = Array.from({ length: 100 }, (_, i) => 400 + i).filter((s) => s !== 408);

/**
 * A marked payload is traced as this token, never field by field: the mark says a resolved secret is somewhere in it
 * under a name the field scan may not know, and a JSON-escaped value slips the runner's exact-literal mask.
 */
const MARKED_PAYLOAD_TRACE = "<withheld: the request carried a resolved secret>";

export interface GitHubApiOptions {
  token: string;
  /** Trace sink for redacted request lines; defaults to a silent trace with nothing masked. */
  io?: TraceIo;
  baseUrl?: string;
  apiVersion?: string;
  /**
   * Real milliseconds in one plugin second: Retry-After units, the retry backoff step, and the write limiter's gap.
   * Undefined reads GSAC_RETRY_BASE_MS once; the plugin topology is the same at every value.
   */
  retryBaseMs?: number;
  /** The limiter the throttling plugin paces through; TIMERS_SCHEDULER unless GSAC_RETRY_BASE_MS selects the immediate one. */
  scheduler?: Scheduler;
  /** Passed to octokit verbatim; octokit-core's own agent string when omitted. */
  userAgent?: string;
}

const SILENT_TRACE: TraceIo = { debug() {}, masked: maskRegistry(() => {}).masked };

/** The Octokit instance is built here and never injected: a consumer needing control over transport or plugins implements GitHubClient directly. */
export class GitHubApi implements GitHubClient {
  private readonly octokit: InstanceType<typeof ActionOctokit>;
  private readonly trace: TraceRedaction;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  constructor(options: GitHubApiOptions) {
    this.baseUrl = options.baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com";
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.trace = new TraceRedaction(options.io ?? SILENT_TRACE);
    const envKnob = envRetryBaseMs();
    const retryBaseMs = options.retryBaseMs ?? envKnob ?? 1000;
    const scheduler =
      options.scheduler ?? (envKnob === undefined ? TIMERS_SCHEDULER : IMMEDIATE_SCHEDULER);
    this.octokit = new ActionOctokit({
      auth: options.token,
      baseUrl: this.baseUrl,
      userAgent: options.userAgent,
      // Octokit's default logger is `console`, which writes request lines with no redaction; see redactingOctokitLog.
      log: redactingOctokitLog(this.trace),
      // Each plugin reads retryAfterBaseValue from its own options section.
      request: { retryAfterBaseValue: retryBaseMs },
      retry: {
        doNotRetry: DO_NOT_RETRY,
        retries: MAX_RETRIES,
        retryAfterBaseValue: retryBaseMs,
      },
      throttle: {
        // The plugin's option types name Bottleneck's whole class; a Scheduler is the slice of it the plugin calls.
        Bottleneck: scheduler as unknown as typeof Bottleneck,
        retryAfterBaseValue: retryBaseMs,
        // The plugin reads global and auth from its state, not from its declared options, hence the cast.
        ...(throttleGroups(scheduler) as Record<keyof ThrottleGroups, Bottleneck.Group>),
        write: new scheduler.Group({
          id: "octokit-write",
          maxConcurrent: 1,
          minTime: retryBaseMs,
        }) as Bottleneck.Group,
        onRateLimit: throttleCallback("rate limit", this.trace),
        onSecondaryRateLimit: throttleCallback("secondary rate limit", this.trace),
      },
    });
  }

  async tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: RequestMark & { accept?: string; raw?: boolean; redactTrace?: boolean },
  ): Promise<ClientAnswer<unknown>> {
    if (!options?.redactTrace) {
      return this.request(method, path, payload, options);
    }
    const slug = repoSlugOf(path);
    if (slug === undefined) {
      throw new Error(`BUG: redactTrace needs a /repos/<owner>/<repo> path, got ${path}`);
    }
    const release = this.trace.hold(slug);
    try {
      return await this.request(method, path, payload, options);
    } finally {
      release();
    }
  }

  /**
   * The paginate plugin walks GitHub's `Link: <url>; rel="next"` header; the request method it walks with is this
   * wrapper over octokit.request, so every page meets the retry and throttling hooks and leaves a trace line. The page
   * body stays here as GitHub sent it, because the plugin's own list normalization rewrites an envelope in place
   * (drops `total_count`, keeps whichever key comes first), so the plugin is handed an empty body in its place. A 409
   * is noted before the plugin reads it as an empty list (GitHub's answer for an empty repository) and surfaces as the
   * error it is.
   */
  async tryList(path: string, options?: ListOptions): Promise<ClientAnswer<unknown[]>> {
    const pages: unknown[] = [];
    let conflict: OctokitHttpError | undefined;
    let current = path;
    // Every page is requested on the route the caller named: GitHub's next Link addresses the repository by id
    // (/repositories/<id>/...), a form the slug redaction cannot match, so only its query (the page cursor) is taken.
    let route: URL | undefined;
    const fetchPage = async (page: EndpointOptions) => {
      const started = Date.now();
      const linked = new URL(page.url);
      route ??= linked;
      const url = new URL(route.href);
      url.search = linked.search;
      current = url.href.startsWith(this.baseUrl) ? url.href.slice(this.baseUrl.length) : url.href;
      const trace = (status: number): void => {
        this.trace.debug(
          `GET ${this.trace.path(current).path} -> ${status} (${Date.now() - started}ms)`,
        );
      };
      try {
        const response = await this.octokit.request({ ...page, url: url.href });
        trace(response.status);
        pages.push(response.data);
        return { ...response, data: [] };
      } catch (error) {
        if (isHttpError(error)) {
          trace(error.status);
          if (error.status === 409) {
            conflict = error;
          }
        }
        throw error;
      }
    };
    const request = Object.assign(fetchPage, {
      endpoint: this.octokit.request.endpoint,
      defaults: this.octokit.request.defaults,
    }) as unknown as RequestInterface;
    // The plugin types a request method's parameters off its route-string overload; at run time it hands them whole
    // to request.endpoint, which merges them into the first page's URL.
    const firstPage = {
      method: "GET",
      url: path,
      per_page: options?.perPage ?? PAGE_SIZE,
      page: 1,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": this.apiVersion,
      },
    } as unknown as Parameters<RequestInterface>[0];
    try {
      for await (const _page of this.octokit.paginate.iterator(request, firstPage)) {
        if (conflict !== undefined) {
          return { error: apiErrorFromHttp(conflict, false) };
        }
        if (options?.until?.(pages[pages.length - 1]) === true) {
          break;
        }
      }
      return { data: pages };
    } catch (error) {
      if (isHttpError(error)) {
        return { error: apiErrorFromHttp(error, false) };
      }
      return {
        failed: transportFailure(`GET ${current}`, transportReason(error, undefined), this.baseUrl),
      };
    }
  }

  private async request(
    method: string,
    path: string,
    payload: unknown,
    options: (RequestMark & { accept?: string; raw?: boolean }) | undefined,
  ): Promise<ClientAnswer<unknown>> {
    const started = Date.now();
    // One serialization, one truth: the scan normalizes the payload and the request sends that SAME tree. A payload that
    // cannot be normalized is never sent; sending what the scan could not inspect would let a stateful object show the
    // scan one thing and the wire another.
    const secretScan = redactSecretPayloadSafe(payload);
    if (secretScan.isErr()) {
      const reason =
        secretScan.error ??
        "its payload is not plain JSON data (a value carrying a function or exotic prototype)";
      return {
        failed: `${method} ${path} was not sent: ${reason}, so it could not be safely inspected for secret fields. Replace that value with a plain string in the settings file`,
      };
    }
    // Either signal withholds: the caller's mark knows the value's origin, the scan knows the wire's field names.
    const marked = options?.carriesSecret === true;
    const carriesSecret = marked || secretScan.value.carriesSecret;
    const trace = (status: number): void => {
      const safe = this.trace.path(path);
      this.trace.debug(
        `${method} ${safe.path} -> ${status} (${Date.now() - started}ms)` +
          (safe.redacted || payload === undefined
            ? ""
            : marked
              ? ` payload: ${MARKED_PAYLOAD_TRACE}`
              : ` payload: ${JSON.stringify(secretScan.value.traced)}`),
      );
    };
    try {
      const response = await this.octokit.request({
        method,
        url: path,
        headers: {
          accept: options?.accept ?? "application/vnd.github+json",
          "x-github-api-version": this.apiVersion,
        },
        // The body is the tree the scan inspected, so octokit never reshapes the payload and the wire carries exactly what was scanned.
        ...(payload === undefined ? {} : { data: secretScan.value.payload }),
      } as unknown as Parameters<InstanceType<typeof ActionOctokit>["request"]>[0]);
      trace(response.status);
      const data = response.data as unknown;
      if (options?.raw) {
        // Non-JSON media type: octokit hands the body back as text.
        return { data: typeof data === "string" ? data : "" };
      }
      // Octokit surfaces 204/empty bodies as ""; the contract is null.
      return { data: data === undefined || data === "" ? null : data };
    } catch (error) {
      if (isHttpError(error)) {
        trace(error.status);
        // Fail closed for a secret-carrying request: an error body may echo the rejected value.
        return { error: apiErrorFromHttp(error, carriesSecret) };
      }
      return {
        failed: transportFailure(
          `${method} ${path}`,
          transportReason(error, carriesSecret ? SECRET_TRANSPORT_WITHHELD : undefined),
          this.baseUrl,
        ),
      };
    }
  }

  /**
   * The load-bearing difference from REST: GraphQL failures arrive as an HTTP 200 carrying a non-empty errors[].
   *
   * any errors[] entry, even beside partial data   -> { error }, so a section never acts on a half-answered query
   * `extensions.warnings` (legacy node-ID notices)  -> the debug trace only
   */
  async tryGraphql(
    op: GraphqlOp,
    variables: Readonly<Record<string, unknown>>,
    slug: string,
    options?: RequestMark,
  ): Promise<ClientAnswer<Record<string, unknown>>> {
    const started = Date.now();
    // The same one-serialization contract as tryRequest, so a future secret-bearing variable is masked and withheld like a REST payload field.
    const scan = redactSecretPayloadSafe(variables);
    if (scan.isErr()) {
      const reason =
        scan.error ??
        "its variables are not plain JSON data (a value carrying a function or exotic prototype)";
      return {
        failed: `GRAPHQL ${op.name} was not sent: ${reason}, so they could not be safely inspected for secret fields. Replace that value with a plain string in the settings file`,
      };
    }
    const marked = options?.carriesSecret === true;
    const carriesSecret = marked || scan.value.carriesSecret;
    // Read live at every emission, never snapshotted at request start: a mask registered mid-flight must redact what follows.
    const redacted = (): boolean => this.trace.isRedacted(slug);
    // The operation addresses its repository in the BODY, which the path redactor never sees: a redacted slug collapses
    // the ENTIRE line, since the variables carry the repository's live state.
    const tracedVariables = marked ? MARKED_PAYLOAD_TRACE : JSON.stringify(scan.value.traced);
    const trace = (status: number, suffix = ""): void => {
      this.trace.debug(
        redacted()
          ? "<redacted>"
          : this.trace.message(
              `GRAPHQL ${op.name} -> ${status} (${Date.now() - started}ms) variables: ${tracedVariables}${suffix}`,
            ),
      );
    };
    // A redacted repository's GraphQL error is rebuilt from the allowlist: its messages quote the slug and live state
    // verbatim, which the exact-literal output mask cannot catch.
    const withholdContent = (): boolean => carriesSecret || redacted();
    const forRedacted = (error: ApiError): ApiError =>
      redacted() ? withheld(error, REDACTED_RESPONSE_WITHHELD) : error;
    let response: { status: number; data: unknown };
    try {
      response = (await this.octokit.request({
        method: "POST",
        url: "/graphql",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": this.apiVersion,
        },
        // operationName makes the request self-describing on the wire (the mock dispatches on it).
        data: { query: op.query, operationName: op.name, variables: scan.value.payload },
      } as unknown as Parameters<InstanceType<typeof ActionOctokit>["request"]>[0])) as {
        status: number;
        data: unknown;
      };
    } catch (error) {
      if (isHttpError(error)) {
        trace(error.status);
        return { error: forRedacted(apiErrorFromHttp(error, withholdContent())) };
      }
      // The throttling plugin inspects GraphQL bodies itself: it retries a RATE_LIMITED errors[] response and, once the
      // retries are spent, rethrows a plain Error carrying the response with no HTTP status (the wire status was 200).
      const rethrownErrors = (error as { response?: { data?: { errors?: unknown } } } | null)
        ?.response?.data?.errors;
      if (Array.isArray(rethrownErrors) && rethrownErrors.length > 0) {
        trace(200);
        return {
          error: forRedacted(apiErrorFromGraphqlErrors(rethrownErrors, withholdContent())),
        };
      }
      return {
        failed: transportFailure(
          `GRAPHQL ${op.name}`,
          transportReason(
            error,
            carriesSecret
              ? SECRET_TRANSPORT_WITHHELD
              : redacted()
                ? REDACTED_TRANSPORT_WITHHELD
                : undefined,
          ),
          this.baseUrl,
        ),
      };
    }
    const body = (response.data ?? {}) as {
      data?: unknown;
      errors?: unknown;
      extensions?: { warnings?: unknown };
    };
    const warnings = body.extensions?.warnings;
    trace(
      response.status,
      Array.isArray(warnings) && warnings.length > 0
        ? // Warning entries are free text that can echo input values like error messages, so a secret-carrying request keeps only the count.
          carriesSecret
          ? ` warnings: ${warnings.length} (details withheld: the request carried a secret field)`
          : ` warnings: ${JSON.stringify(warnings)}`
        : "",
    );
    if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length === 0)) {
      // The GraphQL contract makes errors, when present, a NON-EMPTY list; a malformed value must not read as "no errors"
      // and turn a partial response into a success. The body is never quoted.
      return {
        failed: `GRAPHQL ${op.name} returned a malformed errors value (not a non-empty list); the GraphQL endpoint at ${this.baseUrl} is not answering the GraphQL wire contract. Re-run, and retry later if it persists`,
      };
    }
    const errors = Array.isArray(body.errors) ? body.errors : [];
    if (errors.length > 0) {
      return { error: forRedacted(apiErrorFromGraphqlErrors(errors, withholdContent())) };
    }
    const data = body.data;
    if (!isPlainObject(data)) {
      // A 200 with neither errors nor a data map is outside the GraphQL contract; the body is not quoted, since it could carry private live state.
      return {
        failed: `GRAPHQL ${op.name} returned a response carrying neither errors nor a data object; the GraphQL endpoint at ${this.baseUrl} is not answering the GraphQL wire contract. Re-run, and retry later if it persists`,
      };
    }
    return { data };
  }
}
