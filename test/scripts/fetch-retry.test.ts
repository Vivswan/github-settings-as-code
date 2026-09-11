/**
 * Unit contract for lib/fetch-retry.ts: which failures retry (network
 * errors, timeouts - including mid-body - 5xx, 408, 429), which return
 * immediately (success, plain 4xx), and how exhaustion reports. The fetch
 * and sleep seams are injected, so no test touches the network or waits
 * out a real backoff.
 */

import { describe, expect, test } from "bun:test";
import { fetchTextWithRetry } from "../../.github/scripts/lib/fetch-retry.js";

const URL_UNDER_TEST = "https://raw.githubusercontent.com/owner/repo/ref/artifact.json";

/** A fetch stub replaying `outcomes` in order; a thrown entry rejects. */
function fetchScript(outcomes: Array<Response | Error>): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  calls: () => number;
  sleeps: number[];
  warnings: string[];
} {
  let call = 0;
  const fetchImpl = () => {
    const outcome = outcomes[call];
    call++;
    if (outcome === undefined) {
      throw new Error(`fetch stub called ${call} times but scripted for ${outcomes.length}`);
    }
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };
  return { fetchImpl, calls: () => call, sleeps: [], warnings: [] };
}

function deps(script: ReturnType<typeof fetchScript>) {
  return {
    fetchImpl: script.fetchImpl,
    sleep: (ms: number) => {
      script.sleeps.push(ms);
      return Promise.resolve();
    },
    warn: (line: string) => {
      script.warnings.push(line);
    },
  };
}

/** A 200 whose body stream errors mid-read, like a dropped connection. */
function bodyDropResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset mid-body"));
      },
    }),
  );
}

describe("fetchTextWithRetry", () => {
  test("returns the body on first success without sleeping", async () => {
    const script = fetchScript([new Response("payload")]);
    const fetched = await fetchTextWithRetry("artifact", URL_UNDER_TEST, 1000, deps(script));
    expect(fetched).toEqual({ ok: true, status: 200, statusText: "", text: "payload" });
    expect(script.sleeps).toEqual([]);
  });

  test("retries a network error with exponential backoff, then succeeds", async () => {
    const script = fetchScript([new Error("ECONNRESET"), new Response("payload")]);
    const fetched = await fetchTextWithRetry("artifact", URL_UNDER_TEST, 1000, deps(script));
    expect(fetched.text).toBe("payload");
    expect(script.sleeps).toEqual([2000]);
    expect(script.warnings).toEqual([
      `fetching the artifact: attempt 1/3 for ${URL_UNDER_TEST} failed (ECONNRESET); retrying in 2000ms`,
    ]);
  });

  for (const status of [500, 502, 408, 429]) {
    test(`retries a transient ${status}`, async () => {
      const script = fetchScript([
        new Response("nope", { status, statusText: "transient" }),
        new Response("payload"),
      ]);
      const fetched = await fetchTextWithRetry("artifact", URL_UNDER_TEST, 1000, deps(script));
      expect(fetched.text).toBe("payload");
      expect(script.sleeps).toEqual([2000]);
    });
  }

  test("retries a mid-body drop (the failure a headers-only retry misses)", async () => {
    const script = fetchScript([bodyDropResponse(), new Response("payload")]);
    const fetched = await fetchTextWithRetry("artifact", URL_UNDER_TEST, 1000, deps(script));
    expect(fetched.text).toBe("payload");
    expect(script.calls()).toBe(2);
  });

  test("returns a plain 4xx immediately with an empty body, no retry", async () => {
    const script = fetchScript([new Response("missing", { status: 404, statusText: "Not Found" })]);
    const fetched = await fetchTextWithRetry("artifact", URL_UNDER_TEST, 1000, deps(script));
    expect(fetched).toEqual({ ok: false, status: 404, statusText: "Not Found", text: "" });
    expect(script.calls()).toBe(1);
    expect(script.sleeps).toEqual([]);
  });

  test("exhaustion names the artifact, the attempt count, the last failure, and the host", async () => {
    const script = fetchScript([
      new Error("ECONNRESET"),
      new Response("nope", { status: 503, statusText: "Service Unavailable" }),
      new Error("socket hang up"),
    ]);
    const promise = fetchTextWithRetry("OpenAPI descriptor", URL_UNDER_TEST, 1000, deps(script));
    await expect(promise).rejects.toThrow(
      /fetching the OpenAPI descriptor failed after 3 attempts .*socket hang up.*raw\.githubusercontent\.com/,
    );
    expect(script.calls()).toBe(3);
    expect(script.sleeps).toEqual([2000, 4000]);
  });
});
