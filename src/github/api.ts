/**
 * GitHub REST client on @octokit/rest with the retry and throttling
 * plugins: rate limits (429 and secondary 403s) and transient 5xx/network
 * failures are retried with backoff automatically, honoring Retry-After.
 * Paths are built by the sections, and payloads pass through with every
 * field intact: the JSON body is the payload's own serialization (a
 * byte-identical round-trip for plain data - see redactSecretPayloadSafe),
 * never an endpoint typing that could drop an unknown field.
 */

import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import Bottleneck from "bottleneck/light.js";
import type { Io } from "../io.js";
import { redactSecretPayloadSafe } from "./secret-scan.js";

export interface ApiError {
  status: number;
  message: string;
  body: string;
  /** GitHub's documentation_url for the failing endpoint, when the body carries one. */
  documentationUrl?: string;
  /**
   * Content-free rate-limit classification, from structural signals alone
   * (429, retry-after, errors[].type RATE_LIMITED, the secondary-rate
   * phrase - and, only when the body was withheld for a secret-carrying
   * request, the ambiguous zero-quota header). isRateLimitError reads it
   * alongside its message fallback, so a secondary limit arriving as a 403
   * is never misread as a permission failure even when the message says
   * nothing - or no longer exists.
   */
  rateLimited?: true;
  /**
   * The GraphQL error `type` values behind this error, verbatim, deduped and
   * sorted - present only when the error was mapped from a GraphQL errors[]
   * response in which EVERY entry carried a string type. The HTTP status is
   * a lossy fold (FORBIDDEN and a mixed [FORBIDDEN, UNPROCESSABLE] both land
   * on 403/422 classes), so tolerance decisions read this instead: an
   * untyped or partially-typed response omits the field and is never
   * tolerable. The values are structural enums, never echoes, so the field
   * survives even a withheld (secret-carrying or redacted) response.
   */
  graphqlTypes?: readonly string[];
}

/**
 * The advice appended to a transient (non-permission) API failure: a network
 * blip or a 5xx that survived the retries. The single source shared by the
 * three transient-error builders (discovery's paginate failure and its
 * non-permission status branch, plus multi.ts's remote-file read failure), so
 * the "not a permission problem" wording cannot drift between them.
 */
export const RERUN_ADVICE =
  "This is not a permission problem; re-run the workflow, and retry later if it persists";

/**
 * Pinned X-GitHub-Api-Version. The single source for the header default
 * here, the action.yml `api-version` default, and the inputs fallback; the
 * action-yml contract test asserts the three stay equal.
 */
export const DEFAULT_API_VERSION = "2022-11-28";

/**
 * A GraphQL operation as the transport sees it: the wire dispatch name, the
 * read/write kind (declared explicitly, NEVER derived from the POST method
 * every GraphQL call shares), and the query document. The transport-level
 * slice of the sections' richer GraphqlOpDecl - this module must not import
 * from sections/, so the declaration type extends this shape structurally.
 */
export interface GraphqlOp {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly query: string;
}

/**
 * The one capability everything downstream depends on: a verbatim request
 * that surfaces errors as values. The engine, the sections, discovery,
 * pagination, and the test mock all program against this interface, not
 * the concrete client.
 *
 * `tryGraphql` is the GraphQL sibling of tryRequest: one POST /graphql whose
 * failures - including the errors[] GitHub delivers inside an HTTP 200 - come
 * back as the same ApiError value the REST classifiers already read. `slug`
 * names the owner/repo the operation addresses: GraphQL carries the target in
 * the request BODY, invisible to the URL-based trace redaction, so the client
 * needs it to keep a redacted repository's traces closed.
 *
 * `redactTrace` holds the request's `/repos/<owner>/<repo>` slug redacted for
 * the request's duration, for a caller that must not leak the slug before it
 * knows whether the repository is private (the visibility probe).
 */
export interface GithubClient {
  tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: { accept?: string; raw?: boolean; redactTrace?: boolean },
  ): Promise<{ data: unknown } | { error: ApiError }>;
  tryGraphql(
    op: GraphqlOp,
    variables: Readonly<Record<string, unknown>>,
    slug: string,
  ): Promise<{ data: Record<string, unknown> } | { error: ApiError }>;
}

/**
 * The output-port facet the client traces through: the debug channel and
 * the mask registry its redaction reads.
 */
export type TraceIo = Pick<Io, "debug" | "masked">;

// The slug charset ([\w.-]) stops the match at the segment boundary so an
// octokit line's trailing " - 204 with id ..." is never folded into the name;
// the `i` flag keeps a mixed-case path from slipping the redaction.
const REPO_SLUG = /\/repos\/([\w.-]+\/[\w.-]+)/i;

function repoSlugOf(path: string): string | undefined {
  return path.match(REPO_SLUG)?.[1];
}

/**
 * The client's debug trace with slug redaction: a slug is redacted while it is
 * masked through the Io port or held by an in-flight request (the visibility
 * probe). A traced payload is private content no mask covers, so it is dropped.
 */
export class TraceRedaction {
  // One token per hold, so concurrent holds on the same slug release
  // independently and releasing a token twice is inert.
  private readonly holds = new Set<{ readonly slug: string }>();

  constructor(private readonly io: TraceIo) {}

  debug(line: string): void {
    this.io.debug(line);
  }

  /** Hold `slug` redacted until the returned release runs. */
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
   * Collapse the ENTIRE path of a redacted slug to `<redacted>`: the prefix can
   * carry a team slug and the tail carries live state (branches, labels), so
   * anything but a constant leaks what redaction hides. Full URLs match too.
   */
  path(path: string): { path: string; redacted: boolean } {
    const slug = repoSlugOf(path);
    if (slug && this.isRedacted(slug)) {
      return { path: "<redacted>", redacted: true };
    }
    return { path, redacted: false };
  }

  /**
   * Whole-line redactor for octokit's free-text log lines, where a slug can sit
   * anywhere ("retrying request to o/private after 429"): any held slug or masked
   * value as a case-insensitive substring collapses the line to `<redacted>`.
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

  /** Every redacted needle, lowercased: held slugs plus every masked value. */
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
 * The wholesale replacement for an error response to a secret-carrying
 * request. A 4xx body can ECHO the rejected value inside its free-text
 * message/errors, where no field name finds it, and JSON escaping (quotes,
 * backslashes, newlines) defeats exact-literal masking - so nothing of the
 * body survives; only the HTTP status and the content-free rate-limit
 * classification flag do.
 */
export const SECRET_RESPONSE_WITHHELD =
  "response body withheld: the request carried a secret field and an error body may echo its value";

/**
 * The wholesale replacement for a GraphQL error response addressing a
 * REDACTED repository. GraphQL error messages quote the slug and live state
 * verbatim ("Could not resolve to a Repository with the name 'o/private'"),
 * where a REST denial says only "Not Found" - and the output mask is
 * exact-literal, so a re-cased or name-only mention would slip it. Only the
 * status and the structural classification fields (rateLimited,
 * graphqlTypes) survive.
 */
export const REDACTED_RESPONSE_WITHHELD =
  "response body withheld: the repository is redacted and a GraphQL error message may carry its name or live state";

/** The shape of a GitHub GraphQL error `type`: a closed enum token, never free text. */
const GRAPHQL_TYPE_TOKEN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Rebuild an error from the allowlist (status, the structural classification
 * fields) with `reason` as message and body: constructed, never filtered, so
 * nothing else survives. The one rebuild behind every withholding site.
 */
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

/**
 * Build a throttling-plugin rate-limit callback. The primary and secondary
 * limits are handled identically - trace the (redacted) request, then retry
 * while the wait is within the cap and attempts remain - differing only in the
 * log `label`, so one factory keeps them from drifting.
 */
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
 * The `log` implementation passed to Octokit. Octokit-core and its retry and
 * throttling plugins log every request line - method, URL, status - through
 * this sink; the default sink is `console`, which writes those lines (carrying
 * private slugs and live-state segments like branch names and collaborator
 * logins) to stdout/stderr with no redaction. Each line is free-text prose, not
 * a bare path, so it goes through the whole-message scan, NOT the path
 * redactor (which only finds a `/repos/<slug>` segment and would miss a slug
 * sitting elsewhere in the sentence). Every level is demoted to the debug
 * channel so octokit's chatter stays off normal runs, matching the rest of the
 * client's tracing. Exported so the redaction is unit-testable without
 * constructing the whole client.
 */
type Log = (message: string, ...rest: unknown[]) => void;

export function redactingOctokitLog(trace: TraceRedaction): {
  debug: Log;
  info: Log;
  warn: Log;
  error: Log;
} {
  const redact: Log = (message) => {
    // Octokit passes a string message; any extra args are ignored rather than
    // risk logging an object that embeds an unredacted URL.
    trace.debug(trace.message(String(message)));
  };
  return { debug: redact, info: redact, warn: redact, error: redact };
}

// Never wait out a rate-limit reset longer than this: failing loudly with
// the API message beats stalling a workflow for an hour. Exported so the
// docs contradiction test pins the semantics guide's number to this value.
export const MAX_RETRY_WAIT_S = 60;
// Exported so consumers derive from the one real value instead of
// hand-mirroring it: the test harness builds its retry budgets
// (1 + MAX_RETRIES) from it, and the docs contradiction test pins the
// semantics guide's retry count to it.
export const MAX_RETRIES = 2; // total attempts = 1 + MAX_RETRIES

const ActionOctokit = Octokit.plugin(retry, throttling);

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

/** RETRY_BASE_MS parsed defensively: only a finite, positive number counts. */
function testRetryBaseMs(): number | undefined {
  const value = Number(process.env.RETRY_BASE_MS ?? "");
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Map a caught octokit HTTP error to the ApiError value contract. Shared by
 * tryRequest and tryGraphql, whose HTTP-level failures (a 401, a 5xx that
 * survived the retries) are identical - only the GraphQL-specific errors[]
 * mapping lives elsewhere.
 *
 * When the failing request carried a secret field, the response is replaced
 * wholesale - a 4xx body can ECHO the rejected value inside its free-text
 * message/errors, where no field name finds it, and JSON escaping defeats
 * exact-literal masking - so nothing of the body survives (not even
 * documentation_url); only the HTTP status and the content-free rate-limit
 * classification flag do.
 *
 * The rate-limit classification is structural and computed FIRST, on EVERY
 * path (not just the withheld one): GitHub's primary and secondary limits
 * can arrive as a 403 whose message never contains the literal phrase
 * "rate limit", and misreading one as a missing grant turns a transient
 * limit into permission advice (and, under on-missing-permission: warn, a
 * green run that silently skipped the section). The DEFINITIVE signals are
 * the ones the throttling plugin itself recognizes and no permission 403
 * carries: the plugin's secondary-limit message predicate (\bsecondary
 * rate\b - GitHub documents secondary limits where no rate-limit header is
 * present), the structured errors[].type === "RATE_LIMITED", and the
 * retry-after header. Accepting retry-after ALONE is deliberately broader
 * than the plugin (which reads it only after the phrase matches): no
 * documented 403 carries retry-after without being a rate limit, and a
 * header cannot be spoofed by an echoed value.
 *
 * x-ratelimit-remaining: 0 is AMBIGUOUS on its own: a genuine permission
 * 403 issued on the token's last quota unit carries it too, and flagging
 * that as a rate limit would hide the missing grant behind retry advice. So
 * on the readable path the zero header contributes nothing (a real
 * primary-limit exhaustion says "API rate limit exceeded", which
 * isRateLimitError's message fallback already classifies); only a WITHHELD
 * response - where no message survives to disambiguate - accepts it, the
 * lesser evil against telling a rate-limited user to fix their token. The
 * residual spoof is an operator's own secret containing the exact phrase
 * "secondary rate" echoed into a 403 - theoretical (permission 403s do not
 * echo payloads) and equally bounded.
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
  const definitiveRateLimit =
    error.status === 429 ||
    (error.status === 403 &&
      (headers["retry-after"] !== undefined ||
        errorsRateLimited ||
        /\bsecondary rate\b/i.test(classificationText)));
  const rateLimited =
    definitiveRateLimit ||
    // The ambiguous zero-quota header counts only when the body is withheld
    // and cannot disambiguate; see the doc comment above.
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
 * The hard error for a request that got no HTTP response at all: a
 * network-level failure after the plugins exhausted their retries. `label`
 * names the failing call ("PUT /repos/o/r/topics", "GRAPHQL RepoToggles").
 * `withholdReason`, when given, REPLACES the transport error's own message -
 * some transport failures quote request details in free text, where neither
 * a field name nor the output mask finds a secret or a redacted slug.
 */
function transportFailure(
  label: string,
  error: unknown,
  withholdReason: string | undefined,
  baseUrl: string,
): Error {
  const reason = withholdReason ?? (error instanceof Error ? error.message : String(error));
  return new Error(
    `${label} failed: ${reason}. Check network connectivity from the runner to ${baseUrl}, then re-run the workflow`,
  );
}

/** The withheld transport-failure reason for a secret-carrying request. */
const SECRET_TRANSPORT_WITHHELD =
  "the transport failed before an HTTP response arrived (details withheld: the request carried a secret field)";

/** The withheld transport-failure reason for a redacted repository's request. */
const REDACTED_TRANSPORT_WITHHELD =
  "the transport failed before an HTTP response arrived (details withheld: the repository is redacted)";

export class GithubApi implements GithubClient {
  private readonly octokit: InstanceType<typeof ActionOctokit>;
  private readonly trace: TraceRedaction;
  constructor(
    token: string,
    io: TraceIo,
    private readonly baseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    private readonly apiVersion = DEFAULT_API_VERSION,
    // Test knob override: an explicit value forces the RETRY_BASE_MS scale
    // (used by unit tests that construct the client directly); left undefined,
    // the knob is read once from the environment below.
    retryBaseMsOverride?: number,
  ) {
    this.trace = new TraceRedaction(io);
    // Read the test knob ONCE. `retryBaseMs` scales the plugin waits (1000 =
    // real seconds in production, small under RETRY_BASE_MS). `underTestKnob`
    // is true when the environment sets the knob - the two derive from the one
    // read so it is never consulted twice.
    const envKnob = testRetryBaseMs();
    const retryBaseMs = retryBaseMsOverride ?? envKnob ?? 1000;
    const underTestKnob = envKnob !== undefined;
    // The throttling plugin routes every request through Bottleneck's job
    // scheduler, which paces mutations (its "write" limiter) at 1000ms and adds
    // real per-request latency even at minTime 0 - correct for a real fleet run,
    // but it makes a many-request TEST run wait out tens of seconds. So the
    // plugin is disabled under the knob. Its ONE job the retry plugin does not
    // otherwise cover - 429/secondary-limit RETRY - is restored below so a
    // transient 429 still RECOVERS under the knob (only the recovery outcome
    // matters to tests). The retry TIMING differs from production and that is
    // acceptable: see the doNotRetry note.
    const throttleEnabled = !underTestKnob;
    // Client errors are never retried (permission 403/404s, payload 422s), so
    // the retry plugin's doNotRetry excludes only 408 among the 4xx. Under the
    // test knob it ALSO excludes 429: with the throttling plugin off, the retry
    // plugin becomes the 429 recovery path. Note the retry plugin IGNORES the
    // Retry-After header and backs off quadratically - attempt n waits
    // (n^2 * retryBaseMs) - so under the knob a 429 recovers on a quadratic
    // delay, not the header's value. Production is unchanged: 429 stays in
    // doNotRetry and the throttling plugin paces it, honoring Retry-After.
    const doNotRetry = Array.from({ length: 100 }, (_, i) => 400 + i).filter(
      (s) => s !== 408 && !(underTestKnob && s === 429),
    );
    this.octokit = new ActionOctokit({
      auth: token,
      baseUrl: this.baseUrl,
      // Octokit's default logger is `console`, which writes request lines
      // (method + URL + status, carrying private slugs and live-state segments
      // like branch names) to stdout/stderr with no redaction, bypassing our
      // trace hardening. Route them through the same collapse-to-<redacted>
      // sink; see redactingOctokitLog.
      log: redactingOctokitLog(this.trace),
      // Scales plugin waits (Retry-After units, backoff steps) so tests
      // can run in milliseconds; 1000 = real seconds in production. Each
      // plugin reads the value from its own options section.
      request: { retryAfterBaseValue: retryBaseMs },
      retry: {
        doNotRetry,
        retries: MAX_RETRIES,
        retryAfterBaseValue: retryBaseMs,
      },
      throttle: {
        // Disabled under the test knob (see throttleEnabled above) so a
        // many-request test run does not wait out Bottleneck's per-request
        // scheduling; always enabled in production.
        enabled: throttleEnabled,
        retryAfterBaseValue: retryBaseMs,
        // The plugin paces mutating requests through a "write" limiter with a
        // 1000ms production gap (real seconds between writes). Only used when the
        // plugin is enabled, i.e. in production, where retryBaseMs is 1000.
        write: new Bottleneck.Group({
          id: "octokit-write",
          maxConcurrent: 1,
          minTime: retryBaseMs,
        }),
        // Both rate-limit callbacks are identical but for the log label; one
        // factory keeps them in lockstep. The traced URL is redacted so a
        // rate-limited private-repo request cannot leak its slug.
        onRateLimit: throttleCallback("rate limit", this.trace),
        onSecondaryRateLimit: throttleCallback("secondary rate limit", this.trace),
      },
    });
  }

  /** Verbatim request; surfaces errors as values for callers to classify. */
  async tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: { accept?: string; raw?: boolean; redactTrace?: boolean },
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
    options: { accept?: string; raw?: boolean } | undefined,
  ): Promise<{ data: unknown } | { error: ApiError }> {
    const started = Date.now();
    // One serialization, one truth: the scan normalizes the payload and the
    // request sends that SAME normalized tree (identical bytes for plain
    // data). A payload that cannot be normalized is never sent at all -
    // sending what the scan could not inspect would let a stateful object
    // show the scan one thing and the wire another.
    const secretScan = redactSecretPayloadSafe(payload);
    if (!secretScan.ok) {
      const reason =
        secretScan.reason ??
        "its payload is not plain JSON data (a cyclic value, or a value carrying a function or exotic prototype)";
      throw new Error(
        `${method} ${path} was not sent: ${reason}, so it could not be safely inspected for secret fields. Replace that value with a plain string in the settings file`,
      );
    }
    const trace = (status: number): void => {
      const safe = this.trace.path(path);
      this.trace.debug(
        `${method} ${safe.path} -> ${status} (${Date.now() - started}ms)` +
          (safe.redacted || payload === undefined
            ? ""
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
        // `data` is the request body as the scan normalized it (JSON
        // round-trip of the input - identical bytes for plain data), which
        // keeps the passthrough tenet: octokit never reshapes the payload,
        // and the wire carries exactly the tree the scan inspected.
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
        // Fail closed for a secret-carrying request: apiErrorFromHttp replaces
        // the response wholesale (an error body may echo the rejected value),
        // keeping only the status and the content-free rate-limit flag.
        return { error: apiErrorFromHttp(error, secretScan.carriesSecret) };
      }
      throw transportFailure(
        `${method} ${path}`,
        error,
        secretScan.carriesSecret ? SECRET_TRANSPORT_WITHHELD : undefined,
        this.baseUrl,
      );
    }
  }

  /**
   * One GraphQL operation over POST /graphql, through the same octokit
   * instance as tryRequest - so retry, throttling, auth, and the pinned API
   * version all apply, with zero extra runtime dependencies.
   *
   * The load-bearing difference from REST: GraphQL failures arrive as an HTTP
   * 200 whose body carries a non-empty errors[]. ANY such response maps to
   * { error } - even beside partial data - so a section can never act on a
   * half-answered query (fail closed). HTTP-level failures ride the shared
   * catch unchanged. Non-error `extensions.warnings` (e.g. the legacy
   * node-ID deprecation notices) surface through the debug trace, never as
   * errors.
   *
   * Tracing: the operation addresses its repository in the BODY, which the
   * URL-based path redactor can never see - that is what the `slug`
   * parameter is for. When the slug is redacted the ENTIRE line collapses to
   * `<redacted>` (the variables carry the private repository's live state);
   * otherwise the rendered line still passes through the whole-message scan,
   * so a redacted slug appearing anywhere in it fails closed like every
   * octokit log line.
   */
  async tryGraphql(
    op: GraphqlOp,
    variables: Readonly<Record<string, unknown>>,
    slug: string,
  ): Promise<{ data: Record<string, unknown> } | { error: ApiError }> {
    const started = Date.now();
    // The same one-serialization contract as tryRequest: the secret scan
    // normalizes the variables and the request sends that SAME tree, so a
    // future secret-bearing variable is masked in the trace and withheld
    // from error bodies exactly like a REST payload field.
    const scan = redactSecretPayloadSafe(variables);
    if (!scan.ok) {
      const reason =
        scan.reason ??
        "its variables are not plain JSON data (a cyclic value, or a value carrying a function or exotic prototype)";
      throw new Error(
        `GRAPHQL ${op.name} was not sent: ${reason}, so they could not be safely inspected for secret fields. Replace that value with a plain string in the settings file`,
      );
    }
    // Read live at every emission, never snapshotted at request start: a mask
    // registered while the request is in flight must redact what follows it.
    const redacted = (): boolean => this.trace.isRedacted(slug);
    const trace = (status: number, suffix = ""): void => {
      this.trace.debug(
        redacted()
          ? "<redacted>"
          : this.trace.message(
              `GRAPHQL ${op.name} -> ${status} (${Date.now() - started}ms) variables: ${JSON.stringify(scan.traced)}${suffix}`,
            ),
      );
    };
    // A redacted repository's GraphQL error is rebuilt from the allowlist: its
    // messages quote the slug and live state verbatim, which the exact-literal
    // output mask cannot catch.
    const withholdContent = (): boolean => scan.carriesSecret || redacted();
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
        // operationName makes the request self-describing on the wire (the
        // mock dispatches on it), and the scanned tree is what is sent.
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
      // The throttling plugin inspects GraphQL bodies itself: it retries a
      // RATE_LIMITED errors[] response like any rate limit and, once the
      // retries are spent, rethrows a plain Error carrying the response (no
      // HTTP status on the error - the wire status was 200). Classify that
      // delivered body through the same errors[] mapper as an unretried one.
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
        error,
        scan.carriesSecret
          ? SECRET_TRANSPORT_WITHHELD
          : redacted()
            ? REDACTED_TRANSPORT_WITHHELD
            : undefined,
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
        ? // Warning entries are free text that can echo input values exactly
          // like error messages, so a secret-carrying request keeps only the
          // count.
          scan.carriesSecret
          ? ` warnings: ${warnings.length} (details withheld: the request carried a secret field)`
          : ` warnings: ${JSON.stringify(warnings)}`
        : "",
    );
    if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length === 0)) {
      // The GraphQL contract makes errors, when present, a NON-EMPTY list. A
      // malformed errors value must not read as "no errors" - that would turn
      // a partial response into a success (fail closed, body never quoted).
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
      // A 200 with neither errors nor a data map is outside the GraphQL
      // response contract; nothing downstream can classify it, so fail hard
      // (the body is not quoted - it could carry private live state).
      throw new Error(
        `GRAPHQL ${op.name} returned a response carrying neither errors nor a data object; the GraphQL endpoint at ${this.baseUrl} is not answering the GraphQL wire contract. Re-run the workflow, and retry later if it persists`,
      );
    }
    return { data: data as Record<string, unknown> };
  }
}

/**
 * Map a GraphQL errors[] array (delivered inside an HTTP 200) to the ApiError
 * value the REST classifiers already understand, keyed on GitHub's structured
 * error `type`:
 *   - RATE_LIMITED           -> 403 with the content-free rateLimited flag,
 *     so isRateLimitError classifies it even when the message is withheld;
 *   - FORBIDDEN / INSUFFICIENT_SCOPES -> 403 (isPermissionError);
 *   - NOT_FOUND              -> 404 (fine-grained tokens conceal denied
 *     resources this way, exactly like their REST 404s);
 *   - anything else          -> 422, a payload GitHub rejected.
 * With mixed types the classification-critical ones win in that order: a rate
 * limit must never read as a permission failure, and a permission failure
 * must never read as a bad payload. The message joins every error's message
 * and the body serializes the whole array - unless the request carried a
 * secret field, in which case both are withheld (an error message can echo
 * the rejected value; the `type` fields read here are structural enums, not
 * echoes).
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
  // graphqlTypes only when EVERY entry carried a string type: the field is
  // what tolerance decisions read, and an untyped entry must make the whole
  // response untolerable rather than hide behind its typed siblings.
  const graphqlTypes =
    everyEntryTyped && types.size > 0 ? { graphqlTypes: Object.freeze([...types].sort()) } : {};
  const readable: ApiError = {
    status,
    // GitHub's GraphQL contract makes `message` required on every errors[]
    // entry, so the fallback fires only on off-contract responses - name the
    // structural types (safe enums, never echoes) so the reader is not left
    // with a bare status.
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
 * True when a response is rate limiting in a 403 costume: primary REST
 * rate-limit exhaustion and secondary (abuse) limits arrive as 403, not
 * 429, once the throttling plugin gives up retrying. A withheld response
 * (secret-carrying request) has no message to read, so its content-free
 * `rateLimited` flag stands in - as does a GraphQL RATE_LIMITED error,
 * whose HTTP status is a 200 the mapper rewrites to 403.
 */
export function isRateLimitError(error: ApiError): boolean {
  return (
    error.status === 429 ||
    (error.status === 403 && (error.rateLimited === true || /rate limit/i.test(error.message)))
  );
}

/** True when an error means the token lacks access, as opposed to a bad payload. */
export function isPermissionError(error: ApiError): boolean {
  if (isRateLimitError(error)) {
    return false;
  }
  // 403 = classic missing scope; fine-grained tokens surface missing
  // permissions as 404 on admin endpoints ("Not Found" hides the resource).
  return error.status === 403 || error.status === 404;
}
