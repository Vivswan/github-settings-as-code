import { DEFAULT_API_VERSION, GitHubApi } from "../../src/github/api.js";
import type { TraceIo } from "../../src/github/trace-redaction.js";
import { type Io, maskRegistry } from "../../src/io.js";

const realFetch = globalThis.fetch;

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** The URL a fetch input names, in whichever of its three forms it arrives. */
function hrefOf(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/** The last response repeats, so a retried failure keeps failing. */
export function stubFetch(responses: Array<() => Response>): {
  /** How many requests arrived. */
  calls: number;

  /** Every request's URL path, in order. */
  paths: string[];

  /** Every request's full URL, query included, in order. */
  urls: string[];
} {
  const state = { calls: 0, paths: [] as string[], urls: [] as string[] };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = hrefOf(input);
    const make = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    state.paths.push(new URL(href).pathname);
    state.urls.push(href);
    if (!make) {
      throw new Error("no stubbed response");
    }
    return make();
  }) as unknown as typeof fetch;
  return state;
}

/** A fresh trace facet per test, with an isolated mask registry so one test's masks never redact another's traces. */
export function traceIo(): { io: TraceIo & Pick<Io, "mask">; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    io: { debug: (line) => lines.push(line), ...maskRegistry(() => {}) },
  };
}

// retryAfterBaseValue: 1 turns every plugin wait into milliseconds.
export const api = (io: TraceIo = traceIo().io) =>
  new GitHubApi({
    token: "t",
    io,
    baseUrl: "https://api.test",
    apiVersion: DEFAULT_API_VERSION,
    retryBaseMs: 1,
  });
