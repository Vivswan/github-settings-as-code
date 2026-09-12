/**
 * GitHub REST client on @octokit/core with the retry and throttling plugins; only `octokit.request` is used. Payloads
 * pass through with every field intact: the JSON body is the payload's own serialization (redactSecretPayloadSafe),
 * never an endpoint typing that could drop an unknown field.
 *
 * request-log plugin  -> kept: its per-attempt trace line carries GitHub's request id, which support asks for
 */

import { Octokit } from "@octokit/core";
import { requestLog } from "@octokit/plugin-request-log";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type Bottleneck from "bottleneck/light.js";
import { type Io, maskRegistry } from "../io.js";
import {
  IMMEDIATE_SCHEDULER,
  type Scheduler,
  type ThrottleGroups,
  TIMERS_SCHEDULER,
  throttleGroups,
} from "./scheduler.js";
import { redactSecretPayloadSafe } from "./secret-scan.js";

export interface ApiError {
  status: number;
  message: string;
  body: string;
  /** GitHub's documentation_url for the failing endpoint, when the body carries one. */
  documentationUrl?: string;
  /**
   * Content-free rate-limit classification from structural signals alone (429, retry-after, errors[].type RATE_LIMITED,
   * the secondary-rate phrase; the ambiguous zero-quota header only when the body was withheld). isRateLimitError reads
   * it beside its message fallback, so a secondary limit arriving as a 403 is never misread as a permission failure.
   */
  rateLimited?: true;
  /**
   * Tolerance decisions read this instead of the status, which is a lossy fold (FORBIDDEN and a mixed
   * [FORBIDDEN, UNPROCESSABLE] both land on 403/422). The values are structural enums, never echoes, so the field
   * survives a withheld response.
   *
   * every errors[] entry carries a string type  -> the types, deduped and sorted
   * any entry untyped                           -> omitted, and the response is never tolerable
   */
  graphqlTypes?: readonly string[];
}

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
 * a report; GithubApi honors the mark too, beside its field-name scan, for its direct callers.
 */
export interface RequestMark {
  carriesSecret?: boolean;
}

export interface GithubClient {
  /**
   * `redactTrace` holds the request's `/repos/<owner>/<repo>` slug redacted for the request's duration, for the
   * visibility probe, which must not leak the slug before it knows whether the repository is private.
   */
  tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: RequestMark & { accept?: string; raw?: boolean; redactTrace?: boolean },
  ): Promise<{ data: unknown } | { error: ApiError }>;
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
  ): Promise<{ data: Record<string, unknown> } | { error: ApiError }>;
}

export type TraceIo = Pick<Io, "debug" | "masked">;

// The slug charset ([\w.-]) stops at the segment boundary so an octokit line's trailing " - 204 with id ..." is never
// folded into the name; the `i` flag keeps a mixed-case path from slipping the redaction.
const REPO_SLUG = /\/repos\/([\w.-]+\/[\w.-]+)/i;

function repoSlugOf(path: string): string | undefined {
  return path.match(REPO_SLUG)?.[1];
}

/**
 * A slug is redacted while it is masked through the Io port or held by an in-flight request (the visibility probe). A
 * traced payload is private content no mask covers, so it is dropped.
 */
export class TraceRedaction {
  // One token per hold, so concurrent holds on the same slug release independently and a double release is inert.
  private readonly holds = new Set<{ readonly slug: string }>();

  constructor(private readonly io: TraceIo) {}

  debug(line: string): void {
    this.io.debug(line);
  }

  hold(slug: string): () => void {
    const token = { slug: slug.toLowerCase() };
    this.holds.add(token);
    return () => {
      this.holds.delete(token);
    };
  }

  isRedacted(slug: string): boolean {
    const key = slug.toLowerCase();
    for (const needle of this.needles()) {
      if (needle === key) {
        return true;
      }
    }
    return false;
  }

  /**
   * The ENTIRE path collapses: the prefix can carry a team slug and the tail live state (branches, labels), so
   * anything but a constant leaks what redaction hides.
   */
  path(path: string): { path: string; redacted: boolean } {
    const slug = repoSlugOf(path);
    if (slug && this.isRedacted(slug)) {
      return { path: "<redacted>", redacted: true };
    }
    return { path, redacted: false };
  }

  /**
   * For octokit's free-text log lines, where a slug can sit anywhere ("retrying request to o/private after 429"): any
   * needle as a case-insensitive substring collapses the whole line.
   */
  message(message: string): string {
    const lower = message.toLowerCase();
    for (const needle of this.needles()) {
      if (lower.includes(needle)) {
        return "<redacted>";
      }
    }
    return message;
  }

  private *needles(): Iterable<string> {
    for (const token of this.holds) {
      yield token.slug;
    }
    for (const value of this.io.masked()) {
      // An empty mask would match every line.
      if (value !== "") {
        yield value.toLowerCase();
      }
    }
  }
}

/**
 * A 4xx body can ECHO the rejected value inside its free-text message/errors, where no field name finds it and JSON
 * escaping defeats exact-literal masking, so nothing of the body survives.
 */
export const SECRET_RESPONSE_WITHHELD =
  "response body withheld: the request carried a secret field and an error body may echo its value";

/**
 * GraphQL error messages quote the slug and live state verbatim ("Could not resolve to a Repository with the name
 * 'o/private'") where a REST denial says only "Not Found", and the output mask is exact-literal, so a re-cased mention
 * would slip it.
 */
export const REDACTED_RESPONSE_WITHHELD =
  "response body withheld: the repository is redacted and a GraphQL error message may carry its name or live state";

/** The shape of a GitHub GraphQL error `type`: a closed enum token, never free text. */
const GRAPHQL_TYPE_TOKEN = /^[A-Z][A-Z0-9_]*$/;

/** Constructed from the allowlist, never filtered, so nothing else survives; the one rebuild behind every withholding site. */
export function withheld(error: ApiError, reason: string): ApiError {
  const types =
    Array.isArray(error.graphqlTypes) &&
    error.graphqlTypes.every((type) => typeof type === "string" && GRAPHQL_TYPE_TOKEN.test(type))
      ? Object.freeze([...error.graphqlTypes])
      : undefined;
  return {
    status: error.status,
    message: reason,
    body: reason,
    ...(error.rateLimited === true ? { rateLimited: true } : {}),
    ...(types === undefined ? {} : { graphqlTypes: types }),
  };
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

/**
 * The request-log, retry, and throttling plugins log every request line through this sink; the default sink is
 * `console`, which writes them (private slugs, branch names, collaborator logins) with no redaction.
 *
 * each line is free-text prose  -> the whole-message scan, NOT the path redactor
 * every level                   -> demoted to debug
 */
type Log = (message: string, ...rest: unknown[]) => void;

export function redactingOctokitLog(trace: TraceRedaction): {
  debug: Log;
  info: Log;
  warn: Log;
  error: Log;
} {
  const redact: Log = (message) => {
    // Extra args are ignored rather than risk logging an object that embeds an unredacted URL.
    trace.debug(trace.message(String(message)));
  };
  return { debug: redact, info: redact, warn: redact, error: redact };
}

// Failing loudly with the API message beats stalling a workflow for an hour. Exported so the docs contradiction test
// pins the semantics guide's number to this value.
export const MAX_RETRY_WAIT_S = 60;
// Exported so the test harness builds its retry budgets (1 + MAX_RETRIES) from the one real value, and the docs
// contradiction test pins the guide's retry count to it.
export const MAX_RETRIES = 2;

const ActionOctokit = Octokit.plugin(requestLog, retry, throttling);

interface OctokitHttpError {
  status: number;
  response?: { data?: unknown; headers?: Record<string, unknown> };
  message: string;
}

function isHttpError(error: unknown): error is OctokitHttpError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { status?: unknown }).status === "number" &&
    (error as { response?: unknown }).response !== undefined
  );
}

/** RETRY_BASE_MS is the one knob the e2e runner sets: millisecond plugin units and the immediate scheduler for the spawned bundle. */
function envRetryBaseMs(): number | undefined {
  const value = Number(process.env.RETRY_BASE_MS ?? "");
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Among the 4xx only 408 is retried here; 429 and the rate-limit 403s belong to the throttling plugin, which honors Retry-After. */
const DO_NOT_RETRY = Array.from({ length: 100 }, (_, i) => 400 + i).filter((s) => s !== 408);

/**
 * Shared by tryRequest and tryGraphql. For a secret-carrying request the response is replaced wholesale (a 4xx body may
 * echo the rejected value), so only the status and the content-free rate-limit flag survive; the classification runs FIRST.
 */
function apiErrorFromHttp(error: OctokitHttpError, carriesSecret: boolean): ApiError {
  const body = error.response?.data;
  const headers = error.response?.headers ?? {};
  const classificationText =
    typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message)
      : typeof body === "string" && body
        ? body
        : error.message;
  // Rate limits are classified structurally: GitHub's primary and secondary limits can arrive as a 403 whose message
  // never says "rate limit", and a limit misread as a missing grant becomes permission advice (under
  // on-missing-permission: warn, a silently skipped section).
  //   errors[].type RATE_LIMITED, the secondary-rate phrase  -> the throttling plugin's own signals; no permission 403 carries them
  //   retry-after ALONE                                      -> accepted too: no documented 403 carries it without being a rate limit
  const errorsRateLimited =
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { errors?: unknown }).errors) &&
    ((body as { errors: unknown[] }).errors ?? []).some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: unknown }).type === "RATE_LIMITED",
    );
  // The phrase predicate's one theoretical false positive, an operator's own secret containing "secondary rate" echoed
  // into a 403, is bounded: permission 403s do not echo payloads and a secret-carrying request has its body withheld.
  const definitiveRateLimit =
    error.status === 429 ||
    (error.status === 403 &&
      (headers["retry-after"] !== undefined ||
        errorsRateLimited ||
        /\bsecondary rate\b/i.test(classificationText)));
  const rateLimited =
    definitiveRateLimit ||
    // x-ratelimit-remaining: 0 is AMBIGUOUS alone: a permission 403 issued on the token's last quota unit carries it
    // too. Only a WITHHELD response, with no message left to disambiguate, accepts it; on the readable path real primary
    // exhaustion says "API rate limit exceeded", which isRateLimitError's message fallback already classifies.
    (carriesSecret && error.status === 403 && String(headers["x-ratelimit-remaining"]) === "0");
  let message: string;
  let documentationUrl: string | undefined;
  if (typeof body === "object" && body !== null && "message" in body) {
    message = String((body as { message: unknown }).message);
    const errors = (body as { errors?: unknown }).errors;
    if (errors) {
      message += ` (${JSON.stringify(errors)})`;
    }
    const docUrl = (body as { documentation_url?: unknown }).documentation_url;
    if (typeof docUrl === "string" && docUrl) {
      documentationUrl = docUrl;
    }
  } else if (typeof body === "string" && body) {
    message = body;
  } else {
    message = error.message;
  }
  const readable: ApiError = {
    status: error.status,
    message,
    body: typeof body === "string" ? body : JSON.stringify(body ?? ""),
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(documentationUrl === undefined ? {} : { documentationUrl }),
  };
  return carriesSecret ? withheld(readable, SECRET_RESPONSE_WITHHELD) : readable;
}

/**
 * `reason` is the transport error's own message, or a withholding constant REPLACING it: some transport failures quote
 * request details in free text, where neither a field name nor the output mask finds a secret or a redacted slug. The
 * one renderer behind GithubApi's transport failures and the contract layer's (sections/contract/requests.ts).
 */
export function transportFailure(label: string, reason: string, target: string): Error {
  return new Error(
    `${label} failed: ${reason}. Check network connectivity from the runner to ${target}, then re-run the workflow`,
  );
}

function transportReason(error: unknown, withholdReason: string | undefined): string {
  return withholdReason ?? (error instanceof Error ? error.message : String(error));
}

export const SECRET_TRANSPORT_WITHHELD =
  "the transport failed before an HTTP response arrived (details withheld: the request carried a secret field)";

/**
 * A marked payload is traced as this token, never field by field: the mark says a resolved secret is somewhere in it
 * under a name the field scan may not know, and a JSON-escaped value slips the runner's exact-literal mask.
 */
const MARKED_PAYLOAD_TRACE = "<withheld: the request carried a resolved secret>";

const REDACTED_TRANSPORT_WITHHELD =
  "the transport failed before an HTTP response arrived (details withheld: the repository is redacted)";

export interface GithubApiOptions {
  token: string;
  /** Trace sink for redacted request lines; defaults to a silent trace with nothing masked. */
  io?: TraceIo;
  baseUrl?: string;
  apiVersion?: string;
  /**
   * Real milliseconds in one plugin second: Retry-After units, the retry backoff step, and the write limiter's gap.
   * Undefined reads RETRY_BASE_MS once; the plugin topology is the same at every value.
   */
  retryBaseMs?: number;
  /** The limiter the throttling plugin paces through; TIMERS_SCHEDULER unless RETRY_BASE_MS selects the immediate one. */
  scheduler?: Scheduler;
  /** Passed to octokit verbatim; octokit-core's own agent string when omitted. */
  userAgent?: string;
}

const SILENT_TRACE: TraceIo = { debug() {}, masked: maskRegistry(() => {}).masked };

/** The Octokit instance is built here and never injected: a consumer needing control over transport or plugins implements GithubClient directly. */
export class GithubApi implements GithubClient {
  private readonly octokit: InstanceType<typeof ActionOctokit>;
  private readonly trace: TraceRedaction;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  constructor(options: GithubApiOptions) {
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
  ): Promise<{ data: unknown } | { error: ApiError }> {
    if (!options?.redactTrace) {
      return this.request(method, path, payload, options);
    }
    const slug = repoSlugOf(path);
    if (slug === undefined) {
      throw new Error(`internal: redactTrace needs a /repos/<owner>/<repo> path, got ${path}`);
    }
    const release = this.trace.hold(slug);
    try {
      return await this.request(method, path, payload, options);
    } finally {
      release();
    }
  }

  private async request(
    method: string,
    path: string,
    payload: unknown,
    options: (RequestMark & { accept?: string; raw?: boolean }) | undefined,
  ): Promise<{ data: unknown } | { error: ApiError }> {
    const started = Date.now();
    // One serialization, one truth: the scan normalizes the payload and the request sends that SAME tree. A payload that
    // cannot be normalized is never sent; sending what the scan could not inspect would let a stateful object show the
    // scan one thing and the wire another.
    const secretScan = redactSecretPayloadSafe(payload);
    if (!secretScan.ok) {
      const reason =
        secretScan.reason ??
        "its payload is not plain JSON data (a value carrying a function or exotic prototype)";
      throw new Error(
        `${method} ${path} was not sent: ${reason}, so it could not be safely inspected for secret fields. Replace that value with a plain string in the settings file`,
      );
    }
    // Either signal withholds: the caller's mark knows the value's origin, the scan knows the wire's field names.
    const marked = options?.carriesSecret === true;
    const carriesSecret = marked || secretScan.carriesSecret;
    const trace = (status: number): void => {
      const safe = this.trace.path(path);
      this.trace.debug(
        `${method} ${safe.path} -> ${status} (${Date.now() - started}ms)` +
          (safe.redacted || payload === undefined
            ? ""
            : marked
              ? ` payload: ${MARKED_PAYLOAD_TRACE}`
              : ` payload: ${JSON.stringify(secretScan.traced)}`),
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
        ...(payload === undefined ? {} : { data: secretScan.payload }),
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
      throw transportFailure(
        `${method} ${path}`,
        transportReason(error, carriesSecret ? SECRET_TRANSPORT_WITHHELD : undefined),
        this.baseUrl,
      );
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
  ): Promise<{ data: Record<string, unknown> } | { error: ApiError }> {
    const started = Date.now();
    // The same one-serialization contract as tryRequest, so a future secret-bearing variable is masked and withheld like a REST payload field.
    const scan = redactSecretPayloadSafe(variables);
    if (!scan.ok) {
      const reason =
        scan.reason ??
        "its variables are not plain JSON data (a value carrying a function or exotic prototype)";
      throw new Error(
        `GRAPHQL ${op.name} was not sent: ${reason}, so they could not be safely inspected for secret fields. Replace that value with a plain string in the settings file`,
      );
    }
    const marked = options?.carriesSecret === true;
    const carriesSecret = marked || scan.carriesSecret;
    // Read live at every emission, never snapshotted at request start: a mask registered mid-flight must redact what follows.
    const redacted = (): boolean => this.trace.isRedacted(slug);
    // The operation addresses its repository in the BODY, which the path redactor never sees: a redacted slug collapses
    // the ENTIRE line, since the variables carry the repository's live state.
    const tracedVariables = marked ? MARKED_PAYLOAD_TRACE : JSON.stringify(scan.traced);
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
        data: { query: op.query, operationName: op.name, variables: scan.payload },
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
      throw transportFailure(
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
      );
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
      throw new Error(
        `GRAPHQL ${op.name} returned a malformed errors value (not a non-empty list); the GraphQL endpoint at ${this.baseUrl} is not answering the GraphQL wire contract. Re-run the workflow, and retry later if it persists`,
      );
    }
    const errors = Array.isArray(body.errors) ? body.errors : [];
    if (errors.length > 0) {
      return { error: forRedacted(apiErrorFromGraphqlErrors(errors, withholdContent())) };
    }
    const data = body.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      // A 200 with neither errors nor a data map is outside the GraphQL contract; the body is not quoted, since it could carry private live state.
      throw new Error(
        `GRAPHQL ${op.name} returned a response carrying neither errors nor a data object; the GraphQL endpoint at ${this.baseUrl} is not answering the GraphQL wire contract. Re-run the workflow, and retry later if it persists`,
      );
    }
    return { data: data as Record<string, unknown> };
  }
}

/**
 * Keyed on GitHub's structured error `type`. A secret-carrying request withholds message and body (a `type` enum
 * cannot echo).
 *
 * mixed types  -> the earlier in the ladder wins: a rate limit never reads as a permission failure, nor that as a bad payload
 * NOT_FOUND    -> 404, how fine-grained tokens conceal denied resources, like REST
 */
function apiErrorFromGraphqlErrors(errors: unknown[], carriesSecret: boolean): ApiError {
  const types = new Set<string>();
  const messages: string[] = [];
  let everyEntryTyped = true;
  for (const entry of errors) {
    if (typeof entry !== "object" || entry === null) {
      everyEntryTyped = false;
      continue;
    }
    const type = (entry as { type?: unknown }).type;
    if (typeof type === "string") {
      types.add(type);
    } else {
      everyEntryTyped = false;
    }
    const message = (entry as { message?: unknown }).message;
    if (typeof message === "string" && message) {
      messages.push(message);
    }
  }
  const rateLimited = types.has("RATE_LIMITED");
  const status =
    rateLimited || types.has("FORBIDDEN") || types.has("INSUFFICIENT_SCOPES")
      ? 403
      : types.has("NOT_FOUND")
        ? 404
        : 422;
  // graphqlTypes only when EVERY entry carried a string type: an untyped entry must make the whole response untolerable
  // rather than hide behind its typed siblings.
  const graphqlTypes =
    everyEntryTyped && types.size > 0 ? { graphqlTypes: Object.freeze([...types].sort()) } : {};
  const readable: ApiError = {
    status,
    // `message` is required on every errors[] entry by GitHub's contract, so the fallback fires only off-contract; it
    // names the structural types (safe enums, never echoes) so the reader is not left with a bare status.
    message:
      messages.join("; ") ||
      (types.size > 0
        ? `GraphQL request failed with no error message (error types: ${[...types].sort().join(", ")})`
        : "GraphQL request failed with no error message or error type in the errors[] response"),
    body: JSON.stringify(errors),
    ...(rateLimited ? { rateLimited: true } : {}),
    ...graphqlTypes,
  };
  return carriesSecret ? withheld(readable, SECRET_RESPONSE_WITHHELD) : readable;
}

/**
 * Rate limiting in a 403 costume: primary exhaustion and secondary limits arrive as 403 once the throttling plugin gives
 * up. A withheld response has no message to read, so its `rateLimited` flag stands in, as does a GraphQL RATE_LIMITED
 * error, whose 200 the mapper rewrites to 403.
 */
export function isRateLimitError(error: ApiError): boolean {
  return (
    error.status === 429 ||
    (error.status === 403 && (error.rateLimited === true || /rate limit/i.test(error.message)))
  );
}

/**
 * True when an error means the token lacks access, as opposed to a bad payload: a status fold, blind
 * to the body. A message an endpoint declares as a definitive rejection (sections/contract/endpoints.ts)
 * is classified ahead of this in throwFor, where the endpoint is known.
 */
export function isPermissionError(error: ApiError): boolean {
  if (isRateLimitError(error)) {
    return false;
  }
  // 403 is the classic missing scope; fine-grained tokens surface missing permissions as 404 on admin endpoints.
  return error.status === 403 || error.status === 404;
}
