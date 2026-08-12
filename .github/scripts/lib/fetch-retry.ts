/**
 * Bounded fetch retry with backoff for the artifact-fetching scripts
 * (trim-openapi.ts, fetch-graphql-schema.ts). Both run on a cache miss
 * inside the CI gate, so a single network blip must not fail all-green;
 * a deterministic failure (a 4xx for a wrong ref or file name) still
 * surfaces immediately for the caller to report with its own advice.
 *
 * Lives under lib/ so knip treats it as project code, not an entry point:
 * if every caller stops importing it, knip flags it as unused.
 */

const FETCH_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2_000;

/** Statuses below 500 that are still transient, not deterministic. */
const TRANSIENT_STATUSES = new Set([408, 429]);

/** The outcome of a fetch: the status line plus the fully read body. */
export interface FetchedText {
  ok: boolean;
  status: number;
  statusText: string;
  /** The response body; empty on a non-ok response (callers report status). */
  text: string;
}

/** Injectable seams for tests; production callers pass nothing. */
export interface FetchRetryDeps {
  /** Only the call shape the retry loop uses, so a test stub types plainly. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  warn?: (line: string) => void;
}

/**
 * Fetch `url` and read its whole body, retrying transient failures (network
 * errors, timeouts - including mid-body, so a dropped connection while a
 * multi-MB artifact downloads retries too - 5xx, 408, 429) up to
 * FETCH_ATTEMPTS times with exponential backoff. A deterministic non-ok
 * response (a plain 4xx) is returned as-is with an empty body. `label`
 * names the artifact in retry warnings and the exhaustion error.
 */
export async function fetchTextWithRetry(
  label: string,
  url: string,
  timeoutMs: number,
  deps: FetchRetryDeps = {},
): Promise<FetchedText> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? Bun.sleep;
  const warn = deps.warn ?? console.warn;
  // Hoisted so a malformed URL fails here, not from inside the error path.
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok && !TRANSIENT_STATUSES.has(response.status) && response.status < 500) {
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          text: "",
        };
      }
      if (response.ok) {
        // The body read shares the attempt's AbortSignal, so a stall here
        // also times out and lands in the catch below to be retried.
        const text = await response.text();
        return { ok: true, status: response.status, statusText: response.statusText, text };
      }
      failure = `HTTP ${response.status} ${response.statusText}`;
    } catch (error) {
      failure =
        error instanceof Error && error.name === "TimeoutError"
          ? `timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
    }
    if (attempt >= FETCH_ATTEMPTS) {
      throw new Error(
        `fetching the ${label} failed after ${FETCH_ATTEMPTS} attempts for ${url}: ${failure}. Check network access to ${host} and re-run`,
      );
    }
    const delayMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
    warn(
      `fetching the ${label}: attempt ${attempt}/${FETCH_ATTEMPTS} for ${url} failed (${failure}); retrying in ${delayMs}ms`,
    );
    await sleep(delayMs);
  }
}
