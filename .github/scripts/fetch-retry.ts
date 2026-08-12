/**
 * Bounded fetch retry with backoff for the artifact-fetching scripts
 * (trim-openapi.ts, fetch-graphql-schema.ts). Both run on a cache miss
 * inside the CI gate, so a single network blip must not fail all-green;
 * a deterministic failure (a 4xx for a wrong ref or file name) still
 * surfaces immediately for the caller to report with its own advice.
 */

const FETCH_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 2_000;

/**
 * Fetch `url`, retrying transient failures (network errors, timeouts, 5xx)
 * up to FETCH_ATTEMPTS times with exponential backoff. Any response below
 * 500 - success or a deterministic 4xx - is returned as-is.
 */
export async function fetchWithRetry(url: string, timeoutMs: number): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.status < 500) {
        return response;
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
        `fetching ${url} failed after ${FETCH_ATTEMPTS} attempts: ${failure}. Check network access to raw.githubusercontent.com and re-run`,
      );
    }
    const delayMs = BACKOFF_BASE_MS * 2 ** (attempt - 1);
    console.warn(
      `fetch attempt ${attempt}/${FETCH_ATTEMPTS} for ${url} failed (${failure}); retrying in ${delayMs}ms`,
    );
    await Bun.sleep(delayMs);
  }
}
