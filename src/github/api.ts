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
 * The one capability everything downstream depends on: a verbatim request
 * that surfaces errors as values. The engine, the sections, discovery,
 * pagination, and the test mock all program against this interface, not
 * the concrete client.
 */
export interface GithubClient {
  tryRequest(
    method: string,
    path: string,
    payload?: unknown,
    options?: { accept?: string; raw?: boolean },
  ): Promise<{ data: unknown } | { error: ApiError }>;
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
export const SECRET_FIELD_PLACEHOLDER = "***";

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
 * here and abort the request with a message naming the tags, which beats
 * the garbage their old stringification produced.
 */
function normalizePlainData(value: unknown): unknown {
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
      throw new Error("not plain JSON data");
  }
  if (!isPlainJsonContainer(value)) {
    throw new Error("not plain JSON data");
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
        throw new Error("not plain JSON data");
      }
      const item: unknown = descriptor.value;
      items.push(item === undefined ? null : normalizePlainData(item));
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
      throw new Error("not plain JSON data");
    }
    const item: unknown = descriptor.value;
    if (item === undefined) {
      continue;
    }
    out[key] = normalizePlainData(item);
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
): { ok: true; payload: unknown; traced: unknown; carriesSecret: boolean } | { ok: false } {
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
      return { ok: false };
    }
    const normalized: unknown = normalizePlainData(payload);
    const scanned = redactSecretPayload(normalized);
    return { ok: true, payload: normalized, ...scanned };
  } catch {
    return { ok: false };
  }
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
// the API message beats stalling a workflow for an hour.
const MAX_RETRY_WAIT_S = 60;
// Exported so the test harness derives its retry budgets (1 + MAX_RETRIES)
// from the one real value instead of hand-mirroring it.
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
      throw new Error(
        `${method} ${path} was not sent: its payload could not be safely inspected for secret fields - it is not plain JSON data (a cyclic value, or a YAML explicit tag such as !!timestamp or !!binary, which parse to Date and binary objects). Use a plain string in the settings file instead`,
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
        if (secretScan.carriesSecret) {
          // Fail closed: the request carried a secret field, and the error
          // body may echo the rejected value inside free text. The response is
          // replaced wholesale - before the trace line is written and before
          // the ApiError exists. Nothing from the response BODY survives
          // (not even documentation_url); only the status and the
          // classification flag below remain.
          // Rate limiting normally classifies by message content, which the
          // replacement destroys - so the flag is computed FIRST, from the
          // signals the throttling plugin itself recognizes: the
          // primary-limit header (x-ratelimit-remaining 0), the plugin's
          // secondary-limit message predicate (\bsecondary rate\b - GitHub
          // documents secondary limits where no rate-limit header is
          // present), the structured errors[].type === "RATE_LIMITED", and
          // the retry-after header. Accepting retry-after ALONE is
          // deliberately broader than the plugin (which reads it only after
          // the phrase matches): no documented 403 carries retry-after
          // without being a rate limit, and a header cannot be spoofed by
          // an echoed value. The residual spoof is an operator's own
          // secret containing the exact phrase "secondary rate" echoed into
          // a 403 - theoretical (permission 403s do not echo payloads) and
          // strictly less harmful than telling a rate-limited user to fix
          // their token.
          const headers = error.response?.headers ?? {};
          const body = error.response?.data;
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
          trace(error.status);
          return {
            error: {
              status: error.status,
              message: SECRET_RESPONSE_WITHHELD,
              body: SECRET_RESPONSE_WITHHELD,
              ...(rateLimited ? { rateLimited: true } : {}),
            },
          };
        }
        trace(error.status);
        const body = error.response?.data;
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
          error: {
            status: error.status,
            message,
            body: typeof body === "string" ? body : JSON.stringify(body ?? ""),
            ...(documentationUrl === undefined ? {} : { documentationUrl }),
          },
        };
      }
      // No HTTP response at all: network-level failure after the plugins
      // exhausted their retries. A secret-carrying request withholds even
      // the transport error's message - some transport failures quote
      // request details in free text, where no field name finds a secret.
      const reason = secretScan.carriesSecret
        ? "the transport failed before an HTTP response arrived (details withheld: the request carried a secret field)"
        : error instanceof Error
          ? error.message
          : String(error);
      throw new Error(
        `${method} ${path} failed: ${reason}. Check network connectivity from the runner to ${this.baseUrl}, then re-run the workflow`,
      );
    }
  }
}

/**
 * True when a response is rate limiting in a 403 costume: primary REST
 * rate-limit exhaustion and secondary (abuse) limits arrive as 403, not
 * 429, once the throttling plugin gives up retrying. A withheld response
 * (secret-carrying request) has no message to read, so its content-free
 * `rateLimited` flag stands in.
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
