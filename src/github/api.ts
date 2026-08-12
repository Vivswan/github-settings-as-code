/**
 * GitHub REST client on @octokit/rest with the retry and throttling
 * plugins: rate limits (429 and secondary 403s) and transient 5xx/network
 * failures are retried with backoff automatically, honoring Retry-After.
 * Paths are built by the sections, and payloads pass through with every
 * field intact: the JSON body is the payload's own serialization (a
 * byte-identical round-trip for plain data - see redactSecretPayloadSafe),
 * never an endpoint typing that could drop an unknown field.
 */

import * as core from "@actions/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import Bottleneck from "bottleneck/light.js";

export interface ApiError {
  status: number;
  message: string;
  body: string;
  /** GitHub's documentation_url for the failing endpoint, when the body carries one. */
  documentationUrl?: string;
  /**
   * Content-free rate-limit classification, set only when the response to a
   * secret-carrying request was withheld: isRateLimitError normally reads
   * the message, which the wholesale replacement destroys, and a secondary
   * rate limit arriving as 403 must not be misread as a permission failure.
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
 */
export interface GithubClient {
  tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: { accept?: string; raw?: boolean },
  ): Promise<{ data: unknown } | { error: ApiError }>;
  tryGraphql(
    op: GraphqlOp,
    variables: Readonly<Record<string, unknown>>,
    slug: string,
  ): Promise<{ data: Record<string, unknown> } | { error: ApiError }>;
}

/**
 * Trace line for every API call. Debug output appears only when the run
 * has step debug logging enabled (re-run with debug logging, or set the
 * ACTIONS_STEP_DEBUG secret to true), so normal runs stay quiet while a
 * debugging user sees every request, its payload, status, and timing.
 */
function debugLog(message: string): void {
  core.debug(message);
}

/**
 * Slugs whose requests must not appear verbatim in debug traces. The URL
 * mask (`core.setSecret`) covers the slug wherever it renders, but the
 * traced request PAYLOAD is the private repository's settings content, which
 * no mask covers - so a registered slug's trace collapses the whole path to
 * `<redacted>` and drops the payload entirely. Populated alongside `io.mask`
 * by the run flows once redaction is planned, and pre-populated for the
 * duration of the visibility probe (see repo-visibility.ts) so the probe's own
 * trace - and any throttle-callback trace it triggers - fails closed before the
 * slug's visibility is even known.
 */
const redactedSlugs = new Map<string, number>();

/**
 * Register a hold on a slug so its debug traces are path-redacted and
 * payload-free. Holds are counted: the probe's temporary hold and the run
 * flow's permanent one coexist, and releasing one never clears the other.
 */
export function registerRedactedSlug(slug: string): void {
  const key = slug.toLowerCase();
  redactedSlugs.set(key, (redactedSlugs.get(key) ?? 0) + 1);
}

/** Release one hold on a slug; tracing turns legible when none remain. */
export function unregisterRedactedSlug(slug: string): void {
  const key = slug.toLowerCase();
  const holds = redactedSlugs.get(key) ?? 0;
  if (holds <= 1) {
    redactedSlugs.delete(key);
  } else {
    redactedSlugs.set(key, holds - 1);
  }
}

/**
 * Drop every hold at once. The run flows' registrations are deliberately
 * permanent for the life of the process - an error surfaced AFTER a failed
 * run still traces redacted - so production never calls this. It exists for
 * tests, which share one process: without a reset, one test file's run-flow
 * holds silently redact another file's traces.
 */
export function clearRedactedSlugs(): void {
  redactedSlugs.clear();
}

/**
 * If `path` targets a registered redacted slug, collapse the ENTIRE path to the
 * constant `<redacted>` and flag the payload to be dropped; otherwise return
 * the path unchanged. The whole path is replaced, not just the slug segment:
 * the prefix can itself carry a private name (a team-repo route
 * `/orgs/acme/teams/secret-team/repos/acme/private` leaks the team slug), and
 * the tail and query string carry the private repo's live state (label names,
 * branches, ruleset titles) - so anything but a constant would leak exactly
 * what redaction hides. Matches a `/repos/<owner>/<name>` segment
 * case-insensitively anywhere in the string (full URLs from the throttle
 * callbacks included).
 */
function redactTracePath(path: string): { path: string; redacted: boolean } {
  // The owner/name are constrained to the slug charset (letters, digits, dots,
  // underscores, dashes) so the match stops at the segment boundary and does
  // not swallow trailing text - octokit's own log lines put status and timing
  // after the path ("PATCH /repos/o/r - 204 with id ..."), and a greedy name
  // class would fold that into the "slug" and miss the registry lookup. The `i`
  // flag matches `/REPOS/` too: a mixed-case path must not slip the redaction.
  const match = path.match(/\/repos\/([\w.-]+\/[\w.-]+)/i);
  const slug = match?.[1];
  if (slug && redactedSlugs.has(slug.toLowerCase())) {
    return { path: "<redacted>", redacted: true };
  }
  return { path, redacted: false };
}

/**
 * Message-level redactor for octokit's free-text log LINES (as opposed to the
 * bare request paths redactTracePath handles). Octokit does not hand the logger
 * a clean path - it logs sentences like
 * `GET /repos/e2e-owner/svc-private - 200 with id undefined in 3ms` or
 * `retrying request to e2e-owner/svc-private after 429`, where a registered
 * slug can sit anywhere, not just in `/repos/<slug>` position. So this scans
 * the WHOLE message for any registered slug as a case-insensitive substring and,
 * on a hit, collapses the entire line to `<redacted>` (consistent with the path
 * policy: the text around the slug can carry live-state segments like a branch
 * name, so nothing after a hit is safe to keep). Kept separate from
 * redactTracePath on purpose - teaching the path regex to parse arbitrary log
 * prose is the fragile path.
 */
function redactMessage(message: string): string {
  const lower = message.toLowerCase();
  for (const slug of redactedSlugs.keys()) {
    if (lower.includes(slug)) {
      return "<redacted>";
    }
  }
  return message;
}

/** The constant written over a secret-bearing request field in the debug trace. */
const SECRET_FIELD_PLACEHOLDER = "***";

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

/**
 * Octokit's own body rule: only plain objects and arrays are stringified.
 * Arrays must be genuine base-class arrays - a subclass can override map
 * and iteration, which is foreign code the normalizer must never invoke.
 */
function isPlainJsonContainer(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    return proto === Array.prototype;
  }
  return proto === Object.prototype || proto === null;
}

/**
 * Build the normalized plain-data tree BY HAND, never handing the input to
 * JSON.stringify: stringify honors toJSON, and a toJSON can return a
 * different container that hides a secret under no field name at all
 * ({secret, toJSON: () => [value]} traces the value with no key to match).
 * No payload-supplied code EVER runs: properties are read through their
 * descriptors and an enumerable accessor property is rejected UNREAD (a
 * getter is code, not data - and a getter that ran could sabotage the
 * globals the rest of the pipeline uses), toJSON is never invoked, methods
 * are never dispatched. Non-enumerable and symbol-keyed properties are
 * ignored entirely, never inspected - the set stringify would serialize is
 * exactly the set walked, and only the normalized COPY is ever sent, so
 * ignored code can neither execute nor reach the wire. Anything else that
 * is not JSON plain data - a function, a bigint,
 * a symbol, a class instance, a non-plain prototype, an accessor - THROWS
 * into the caller's fail-closed catch. Cycles exhaust the stack and are
 * caught the same way.
 *
 * For plain JSON data the output stringifies byte-identically to the
 * input: undefined-valued object keys are dropped, undefined array items,
 * holes, and non-finite numbers become null - exactly JSON.stringify's own
 * rules.
 * Note YAML can step OUTSIDE plain data through explicit tags
 * (!!timestamp parses to a Date, !!binary to a Uint8Array); those throw
 * here and abort the request with a message naming the offending field's
 * key path and value class, which beats the garbage their old
 * stringification produced.
 */
/**
 * The typed rejection normalizePlainData raises, carrying WHERE (the key
 * path, field names only - never a value) and WHAT (the value class) so the
 * abort message can name the offending field. redactSecretPayloadSafe
 * rethrows only THIS class's information through its fail-closed catch;
 * anything else a hostile object throws stays swallowed so no foreign
 * message can leak.
 */
class NotPlainDataError extends Error {
  constructor(
    readonly path: readonly string[],
    readonly kind: string,
  ) {
    super("not plain JSON data");
  }
}

/** Render a normalizePlainData key path ("config.starts_at", "contexts[2]"). */
function renderKeyPath(path: readonly string[]): string {
  return path
    .map((segment, index) =>
      /^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
}

/** The value class of a non-plain value, without running any of its code. */
function nonPlainKind(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return `a ${typeof value}`;
  }
  // Prototype comparison only - the same reflective read
  // isPlainJsonContainer already performs; no payload method is dispatched.
  const proto = Object.getPrototypeOf(value);
  if (proto === Date.prototype) {
    return "a Date, e.g. from a YAML !!timestamp tag";
  }
  if (proto === Uint8Array.prototype) {
    return "binary data, e.g. from a YAML !!binary tag";
  }
  return "a non-plain object";
}

function normalizePlainData(value: unknown, path: string[] = []): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "object":
      break;
    default:
      throw new NotPlainDataError(path, nonPlainKind(value));
  }
  if (!isPlainJsonContainer(value)) {
    throw new NotPlainDataError(path, nonPlainKind(value));
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    // Base-class array (isPlainJsonContainer checked the prototype); a
    // manual index loop over descriptors never dispatches .map or invokes
    // an index accessor someone defineProperty'd onto the array.
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[index];
      if (descriptor === undefined) {
        items.push(null); // a hole; stringify renders it null
        continue;
      }
      if (!("value" in descriptor)) {
        throw new NotPlainDataError([...path, String(index)], "an accessor property");
      }
      const item: unknown = descriptor.value;
      items.push(item === undefined ? null : normalizePlainData(item, [...path, String(index)]));
    }
    return items;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      continue;
    }
    if (!("value" in descriptor)) {
      throw new NotPlainDataError([...path, key], "an accessor property");
    }
    const item: unknown = descriptor.value;
    if (item === undefined) {
      continue;
    }
    out[key] = normalizePlainData(item, [...path, key]);
  }
  return out;
}

/**
 * The scan entry point: normalize, then walk. The hand-rolled
 * normalization (see normalizePlainData) reads the input once into a pure
 * plain-data tree; redactSecretPayload walks that tree, the trace prints
 * it (masked), and the request SENDS it - one read, one truth, and no
 * exotic object can make the scan, the trace, and the wire disagree.
 * YAML-derived payloads are plain data apart from the explicit-tag escape
 * hatch normalizePlainData documents; this is the runtime enforcement of
 * that boundary, and nothing payload-supplied is ever executed on the way.
 *
 * Primitives pass through untouched - they carry no named fields for the
 * scan, and a bare-value secret is unsupported by design. Any other
 * non-plain payload (a Buffer, a typed array, a stream, anything carrying
 * a function or exotic prototype anywhere in its graph) fails `ok: false`
 * and is never sent: octokit would pass a non-plain body to fetch
 * verbatim, so normalizing it would silently change the wire, and sending
 * it unscanned would be a blind spot. The caller aborts instead of
 * sending what it could not inspect.
 */
function redactSecretPayloadSafe(
  payload: unknown,
):
  | { ok: true; payload: unknown; traced: unknown; carriesSecret: boolean }
  | { ok: false; reason?: string } {
  if (payload === undefined) {
    return { ok: true, payload: undefined, traced: undefined, carriesSecret: false };
  }
  // Everything reflective happens INSIDE the try: even Array.isArray and
  // Object.getPrototypeOf can throw on a hostile proxy (a throwing or
  // revoked trap), and an error thrown before the guard could carry a
  // secret in its message.
  try {
    if (typeof payload !== "object" || payload === null) {
      // Only JSON primitives pass through - a function, bigint or symbol
      // cannot be JSON-encoded and fails closed instead of reaching
      // octokit un-normalized.
      const jsonPrimitive =
        payload === null ||
        typeof payload === "string" ||
        typeof payload === "boolean" ||
        (typeof payload === "number" && Number.isFinite(payload));
      return jsonPrimitive
        ? { ok: true, payload, traced: payload, carriesSecret: false }
        : { ok: false };
    }
    if (!isPlainJsonContainer(payload)) {
      return {
        ok: false,
        reason: describeNotPlain(new NotPlainDataError([], nonPlainKind(payload))),
      };
    }
    const normalized: unknown = normalizePlainData(payload);
    const scanned = redactSecretPayload(normalized);
    return { ok: true, payload: normalized, ...scanned };
  } catch (error) {
    // Only our own typed rejection may contribute prose: it carries key
    // PATHS (field names) and a value-class word, never a value - anything
    // a hostile object threw is discarded wholesale.
    return error instanceof NotPlainDataError
      ? { ok: false, reason: describeNotPlain(error) }
      : { ok: false };
  }
}

/** The abort-message clause for a non-plain payload, naming field and class. */
function describeNotPlain(error: NotPlainDataError): string {
  const where = error.path.length > 0 ? `the value at "${renderKeyPath(error.path)}"` : "the value";
  return `${where} is not plain JSON data (${error.kind})`;
}

/** Request-payload field names whose values are secrets wherever they appear. */
const SECRET_FIELD_NAMES = new Set(["secret", "encrypted_value"]);

/**
 * Structural redaction of secret-bearing request fields before tracing.
 * The scan is recursive over objects and arrays and keys on the FIELD
 * NAMES alone (`secret`, `encrypted_value`), so a consumer nesting one
 * level deeper - or a new consumer entirely - is covered without declaring
 * anything here; an unenforced "declare your shape here" contract is how a
 * leak happens. Field-name keying cannot cover an UNNAMED value: a bare
 * string body has no key to match, so a future consumer must never send a
 * secret as the whole payload.
 * Copy-on-write: when no secret field is present the input is returned
 * unchanged (the trace is byte-identical); on a hit, `traced`
 * is a structural copy with only the secret fields masked - the request
 * sends the unmasked tree - and `carriesSecret` flags the request for
 * fail-closed error handling.
 * Over-matching an innocent field that happens to be named `secret` costs
 * a masked trace line and a withheld error body, never a wrong request.
 */
function redactSecretPayload(payload: unknown): { traced: unknown; carriesSecret: boolean } {
  if (typeof payload !== "object" || payload === null) {
    return { traced: payload, carriesSecret: false };
  }
  if (Array.isArray(payload)) {
    let hit = false;
    // Index loop, not .map: the walker must not dispatch through mutable
    // prototype methods (the tree it walks is ours, but the habit is the
    // guarantee).
    const traced: unknown[] = [];
    for (let index = 0; index < payload.length; index++) {
      const scanned = redactSecretPayload(payload[index]);
      hit = hit || scanned.carriesSecret;
      traced.push(scanned.traced);
    }
    return hit ? { traced, carriesSecret: true } : { traced: payload, carriesSecret: false };
  }
  const record = payload as Record<string, unknown>;
  let hit = false;
  // Null prototype: JSON.parse creates own `__proto__` DATA properties, and
  // assigning that key through a plain `{}` would hit the prototype setter
  // and silently drop the branch from the trace.
  const traced: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      traced[key] = SECRET_FIELD_PLACEHOLDER;
      hit = true;
    } else {
      const scanned = redactSecretPayload(value);
      hit = hit || scanned.carriesSecret;
      traced[key] = scanned.traced;
    }
  }
  return hit ? { traced, carriesSecret: true } : { traced: payload, carriesSecret: false };
}

/**
 * Build a throttling-plugin rate-limit callback. The primary and secondary
 * limits are handled identically - trace the (redacted) request, then retry
 * while the wait is within the cap and attempts remain - differing only in the
 * log `label`, so one factory keeps them from drifting.
 */
function throttleCallback(
  label: string,
): (
  retryAfter: number,
  options: { method: string; url: string },
  octokit: unknown,
  retryCount: number,
) => boolean {
  return (retryAfter, options, _octokit, retryCount) => {
    debugLog(
      `${label} on ${options.method} ${redactTracePath(options.url).path}; retry ${retryCount + 1}/${MAX_RETRIES} after ${retryAfter}s`,
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
 * a bare path, so it goes through `redactMessage` (a whole-message slug scan),
 * NOT `redactTracePath` (which only finds a `/repos/<slug>` segment and would
 * miss a slug sitting elsewhere in the sentence). Every level is demoted to the
 * debug channel so octokit's chatter stays off normal runs, matching the rest
 * of the client's tracing. Exported so the redaction is unit-testable without
 * constructing the whole client.
 */
type Log = (message: string, ...rest: unknown[]) => void;

export const redactingOctokitLog: { debug: Log; info: Log; warn: Log; error: Log } = (() => {
  const redact: Log = (message) => {
    // Octokit passes a string message; any extra args are ignored rather than
    // risk logging an object that embeds an unredacted URL.
    debugLog(redactMessage(String(message)));
  };
  return { debug: redact, info: redact, warn: redact, error: redact };
})();

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
 * green run that silently skipped the section). The signals are the ones
 * the throttling plugin itself recognizes: the primary-limit header
 * (x-ratelimit-remaining 0), the plugin's secondary-limit message predicate
 * (\bsecondary rate\b - GitHub documents secondary limits where no
 * rate-limit header is present), the structured errors[].type ===
 * "RATE_LIMITED", and the retry-after header. Accepting retry-after ALONE is
 * deliberately broader than the plugin (which reads it only after the phrase
 * matches): no documented 403 carries retry-after without being a rate limit,
 * and a header cannot be spoofed by an echoed value. The residual spoof is an
 * operator's own secret containing the exact phrase "secondary rate" echoed
 * into a 403 - theoretical (permission 403s do not echo payloads) and
 * strictly less harmful than telling a rate-limited user to fix their token.
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
  const rateLimited =
    error.status === 429 ||
    (error.status === 403 &&
      (String(headers["x-ratelimit-remaining"]) === "0" ||
        headers["retry-after"] !== undefined ||
        errorsRateLimited ||
        /\bsecondary rate\b/i.test(classificationText)));
  if (carriesSecret) {
    return {
      status: error.status,
      message: SECRET_RESPONSE_WITHHELD,
      body: SECRET_RESPONSE_WITHHELD,
      ...(rateLimited ? { rateLimited: true } : {}),
    };
  }
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
  return {
    status: error.status,
    message,
    body: typeof body === "string" ? body : JSON.stringify(body ?? ""),
    ...(rateLimited ? { rateLimited: true } : {}),
    ...(documentationUrl === undefined ? {} : { documentationUrl }),
  };
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
  constructor(
    token: string,
    private readonly baseUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    private readonly apiVersion = DEFAULT_API_VERSION,
    // Test knob override: an explicit value forces the RETRY_BASE_MS scale
    // (used by unit tests that construct the client directly); left undefined,
    // the knob is read once from the environment below.
    retryBaseMsOverride?: number,
  ) {
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
      log: redactingOctokitLog,
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
        onRateLimit: throttleCallback("rate limit"),
        onSecondaryRateLimit: throttleCallback("secondary rate limit"),
      },
    });
  }

  /** Verbatim request; surfaces errors as values for callers to classify. */
  async tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: { accept?: string; raw?: boolean },
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
      const safe = redactTracePath(path);
      debugLog(
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
   * URL-based redactTracePath can never see - that is what the `slug`
   * parameter is for. When the slug is registered redacted the ENTIRE line
   * collapses to `<redacted>` (the variables carry the private repository's
   * live state); otherwise the rendered line still passes through
   * redactMessage, so a registered slug appearing anywhere in it fails
   * closed like every octokit log line.
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
    const redacted = redactedSlugs.has(slug.toLowerCase());
    const trace = (status: number, suffix = ""): void => {
      debugLog(
        redacted
          ? "<redacted>"
          : redactMessage(
              `GRAPHQL ${op.name} -> ${status} (${Date.now() - started}ms) variables: ${JSON.stringify(scan.traced)}${suffix}`,
            ),
      );
    };
    // A redacted repository's GraphQL error content is withheld wholesale at
    // this transport, like a secret-carrying request's: GraphQL error
    // messages quote the slug and live state verbatim where REST denials say
    // "Not Found", and the exact-literal output mask cannot catch a re-cased
    // or name-only mention. The mappers below already classify with
    // withholding on (so the content-free rateLimited flag is computed from
    // structural signals, never the destroyed message); this wrapper then
    // REBUILDS the error from a whitelist - status plus the structural
    // classification fields - swapping in the redaction prose, so no field a
    // mapper may add later can leak by default.
    const withholdContent = scan.carriesSecret || redacted;
    const withheld = (error: ApiError): ApiError =>
      redacted
        ? {
            status: error.status,
            message: REDACTED_RESPONSE_WITHHELD,
            body: REDACTED_RESPONSE_WITHHELD,
            ...(error.rateLimited ? { rateLimited: true as const } : {}),
            ...(error.graphqlTypes ? { graphqlTypes: error.graphqlTypes } : {}),
          }
        : error;
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
        return { error: withheld(apiErrorFromHttp(error, withholdContent)) };
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
        return { error: withheld(apiErrorFromGraphqlErrors(rethrownErrors, withholdContent)) };
      }
      throw transportFailure(
        `GRAPHQL ${op.name}`,
        error,
        scan.carriesSecret
          ? SECRET_TRANSPORT_WITHHELD
          : redacted
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
      return { error: withheld(apiErrorFromGraphqlErrors(errors, withholdContent)) };
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
  if (carriesSecret) {
    return {
      status,
      message: SECRET_RESPONSE_WITHHELD,
      body: SECRET_RESPONSE_WITHHELD,
      ...(rateLimited ? { rateLimited: true } : {}),
      ...graphqlTypes,
    };
  }
  return {
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
