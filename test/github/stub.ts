/** Shared fetch stubbing and per-test trace facets for the github/ client tests. */

import { GithubApi, type TraceIo } from "../../src/github/api.js";
import { type Io, maskRegistry } from "../../src/io.js";

const realFetch = globalThis.fetch;

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/**
 * Stub fetch with a fixed response sequence (one per call, in order; the last
 * one repeats, so a retried failure keeps failing). Counts the calls and
 * records each call's pathname, so a test can pin WHICH routes were touched
 * and in what order, not just how many.
 */
export function stubFetch(responses: Array<() => Response>): {
  calls: number;
  paths: string[];
} {
  const state = { calls: 0, paths: [] as string[] };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const make = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    state.paths.push(new URL(href).pathname);
    if (!make) {
      throw new Error("no stubbed response");
    }
    return make();
  }) as unknown as typeof fetch;
  return state;
}

/**
 * A fresh trace facet per test: the debug lines the client emitted and an
 * isolated mask registry, so one test's masks never redact another's traces.
 */
export function traceIo(): { io: TraceIo & Pick<Io, "mask">; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: { debug: (line) => lines.push(line), ...maskRegistry(() => {}) },
  };
}

// retryAfterBaseValue: 1 turns every plugin wait into milliseconds.
export const api = (io: TraceIo = traceIo().io) =>
  new GithubApi({
    token: "t",
    io,
    baseUrl: "https://api.test",
    apiVersion: "2022-11-28",
    retryBaseMs: 1,
  });
