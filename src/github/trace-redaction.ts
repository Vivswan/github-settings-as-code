/**
 * What the client's trace lines may show of a redacted target; TraceIo is the slice of Io the client (api.ts) takes
 * for it. Two rules, either one enough:
 *
 *   a request marked as serving a redacted target  -> the trace is sealed until it settles (during)
 *   a slug masked through the Io port              -> every line naming it collapses, whoever sent the request
 *
 * Octokit's plugin log runs through the same rules (redactingOctokitLog).
 */

import type { Io } from "../io.js";
import { SLUG_SEGMENT, slugKey } from "./slug.js";

export type TraceIo = Pick<Io, "debug" | "masked">;

// The segment charset stops at the segment boundary so an octokit line's trailing " - 204 with id ..." is never folded into the name, and the `i` flag keeps a mixed-case path from slipping the redaction.
const REPO_SLUG = new RegExp(`/repos/(${SLUG_SEGMENT}/${SLUG_SEGMENT})`, "i");

// A collapsed path and a collapsed plugin line read the same on every route, so the constant carries nothing of either.
const REDACTED = "<redacted>";

/** A traced payload is private content no mask covers, so a redacted path drops it. */
export class TraceRedaction {
  /** How many requests in flight serve a redacted target. */
  private sealed = 0;

  constructor(private readonly io: TraceIo) {}

  debug(line: string): void {
    this.io.debug(line);
  }

  /**
   * Runs `request`; when it serves a redacted target, no line written until it settles shows a path or a payload.
   * The seal is the whole trace's, not the request's: a plugin logs through the client, so its line for this
   * request cannot be told from its line for another one in flight beside it.
   */
  async during<T>(servesRedactedTarget: boolean, request: () => Promise<T>): Promise<T> {
    if (!servesRedactedTarget) {
      return request();
    }

    this.sealed += 1;
    try {
      return await request();
    } finally {
      this.sealed -= 1;
    }
  }

  isRedacted(slug: string): boolean {
    const key = slugKey(slug);
    for (const needle of this.needles()) {
      if (needle === key) {
        return true;
      }
    }
    return false;
  }

  /**
   * The ENTIRE path collapses: the prefix can carry a team slug and the tail live state (branches, labels), so
   * anything but a constant leaks what redaction hides.
   */
  path(path: string): { path: string; redacted: boolean } {
    const slug = path.match(REPO_SLUG)?.[1];
    if (this.sealed > 0 || (slug !== undefined && this.isRedacted(slug))) {
      return { path: REDACTED, redacted: true };
    }
    return { path, redacted: false };
  }

  /**
   * For octokit's free-text log lines, where a slug can sit anywhere ("retrying request to o/private after 429"): any
   * needle as a case-insensitive substring collapses the whole line.
   */
  message(message: string): string {
    if (this.sealed > 0) {
      return REDACTED;
    }

    const lower = message.toLowerCase();
    for (const needle of this.needles()) {
      if (lower.includes(needle)) {
        return REDACTED;
      }
    }
    return message;
  }

  private *needles(): Iterable<string> {
    for (const value of this.io.masked()) {
      // An empty mask would match every line.
      if (value !== "") {
        yield value.toLowerCase();
      }
    }
  }
}

/**
 * The request-log, retry, and throttling plugins log every request line through this sink; the default sink is
 * `console`, which writes them (private slugs, branch names, collaborator logins) with no redaction.
 *
 * each line is free-text prose  -> the whole-message scan, NOT the path redactor
 * every level                   -> demoted to debug
 */
type Log = (message: string, ...rest: unknown[]) => void;

export function redactingOctokitLog(trace: TraceRedaction): {
  debug: Log;
  info: Log;
  warn: Log;
  error: Log;
} {
  const redact: Log = (message) => {
    // Extra args are ignored rather than risk logging an object that embeds an unredacted URL.
    trace.debug(trace.message(String(message)));
  };
  return { debug: redact, info: redact, warn: redact, error: redact };
}
