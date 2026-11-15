import { mock, spyOn } from "bun:test";
import { DEFAULT_API_VERSION, GitHubApi } from "../../src/github/api.js";
import type { TraceIo } from "../../src/github/trace-redaction.js";
import { type Io, maskRegistry } from "../../src/io.js";

/** Every later request goes to `answer` until restoreFetch; the spy holds the real fetch meanwhile. */
export function replaceFetch(
  answer: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  spyOn(globalThis, "fetch").mockImplementation(answer as unknown as typeof fetch);
}

/** Puts the real fetch back; a file that replaces fetch runs this after each test, so a failed test leaks no stub. */
export function restoreFetch(): void {
  spyOn(globalThis, "fetch").mockRestore();
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

/** The last response repeats, so a retried failure keeps failing. The record is this stub's own mock, so a second stub in one test starts empty. */
export function stubFetch(responses: Array<() => Response>): {
  /** How many requests arrived. */
  readonly calls: number;

  /** Every request's URL path, in order. */
  readonly paths: string[];

  /** Every request's full URL, query included, in order. */
  readonly urls: string[];
} {
  const answer = mock(async (_input: string | URL | Request) => {
    // The mock records a call before it answers it, so the record's length is this request's ordinal.
    const make = responses[Math.min(answer.mock.calls.length, responses.length) - 1];
    if (!make) {
      throw new Error("no stubbed response");
    }
    return make();
  });
  replaceFetch(answer);
  const urls = (): string[] => answer.mock.calls.map(([input]) => hrefOf(input));
  return {
    get calls() {
      return answer.mock.calls.length;
    },
    get paths() {
      return urls().map((href) => new URL(href).pathname);
    },
    get urls() {
      return urls();
    },
  };
}

/** A stubbed JSON answer as a factory, the shape stubFetch and a route table take, so every request reads a fresh body. */
export const json = (body: unknown) => (): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** A trace line with its timing folded, so a whole line compares. */
export const timeless = (line: string): string => line.replace(/\d+ms/, "Nms");

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
