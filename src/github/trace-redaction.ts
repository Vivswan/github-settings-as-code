/**
 * Slug redaction of the client's trace lines: a /repos/<owner>/<repo> slug collapses its line while the Io port masks
 * it or an in-flight request holds it (GitHubApi's redactTrace, for the visibility probe), and octokit's plugin log
 * runs through the same scan (redactingOctokitLog). TraceIo is the slice of Io the client (api.ts) takes for this.
 */

import type { Io } from "../io.js";
import { type SlugKey, slugKey } from "./slug.js";

export type TraceIo = Pick<Io, "debug" | "masked">;

// The slug charset ([\w.-]) stops at the segment boundary so an octokit line's trailing " - 204 with id ..." is never
// folded into the name; the `i` flag keeps a mixed-case path from slipping the redaction.
const REPO_SLUG = /\/repos\/([\w.-]+\/[\w.-]+)/i;

export function repoSlugOf(path: string): string | undefined {
  return path.match(REPO_SLUG)?.[1];
}

/**
 * A slug is redacted while it is masked through the Io port or held by an in-flight request (the visibility probe). A
 * traced payload is private content no mask covers, so it is dropped.
 */
export class TraceRedaction {
  // One token per hold, so concurrent holds on the same slug release independently and a double release is inert.
  private readonly holds = new Set<{ readonly slug: SlugKey }>();

  constructor(private readonly io: TraceIo) {}

  debug(line: string): void {
    this.io.debug(line);
  }

  hold(slug: string): () => void {
    const token = { slug: slugKey(slug) };
    this.holds.add(token);
    return () => {
      this.holds.delete(token);
    };
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
    const slug = repoSlugOf(path);
    if (slug && this.isRedacted(slug)) {
      return { path: "<redacted>", redacted: true };
    }
    return { path, redacted: false };
  }

  /**
   * For octokit's free-text log lines, where a slug can sit anywhere ("retrying request to o/private after 429"): any
   * needle as a case-insensitive substring collapses the whole line.
   */
  message(message: string): string {
    const lower = message.toLowerCase();
    for (const needle of this.needles()) {
      if (lower.includes(needle)) {
        return "<redacted>";
      }
    }
    return message;
  }

  private *needles(): Iterable<string> {
    for (const token of this.holds) {
      yield token.slug;
    }
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
