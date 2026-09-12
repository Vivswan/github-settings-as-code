/**
 * Bounded fetch retry with backoff for trim-openapi.ts and fetch-graphql-schema.ts, which run on a cache miss inside
 * the CI gate, so a single network blip must not fail all-green; a deterministic 4xx still surfaces immediately.
 * Under lib/ so knip treats it as project code: if every caller stops importing it, knip flags it as unused.
 */

const FETCH_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2_000;

/** Statuses below 500 that are still transient, not deterministic. */
const TRANSIENT_STATUSES = new Set([408, 429]);

export interface FetchedText {
  ok: boolean;
  status: number;
  statusText: string;
  /** Empty on a non-ok response; callers report the status. */
  text: string;
}

/** Injectable seams for tests; production callers pass nothing. */
export interface FetchRetryDeps {
  /** Only the call shape the retry loop uses, so a test stub types plainly. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  warn?: (line: string) => void;
}

/** Timeouts include mid-body, so a dropped connection while a multi-MB artifact downloads retries too. A deterministic
 * non-ok response (a plain 4xx) comes back as-is with an empty body rather than retrying. */
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
        // The body read shares the attempt's AbortSignal, so a stall here also times out and is retried.
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
