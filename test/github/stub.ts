/** Shared fetch stubbing and per-test trace facets for the github/ client tests. */

import { GithubApi, type TraceIo } from "../../src/github/api.js";
import { type Io, maskRegistry } from "../../src/io.js";

const realFetch = globalThis.fetch;

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** Stub fetch with a fixed response sequence (last one repeats); count calls. */
export function stubFetch(responses: Array<() => Response>): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    const make = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
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
  new GithubApi("t", io, "https://api.test", "2022-11-28", 1);
