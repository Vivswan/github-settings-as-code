import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  type ApiError,
  GithubApi,
  isPermissionError,
  isRateLimitError,
  MAX_RETRIES,
  MAX_RETRY_WAIT_S,
  redactingOctokitLog,
  SECRET_RESPONSE_WITHHELD,
  TraceRedaction,
  withheld,
} from "../../src/github/api.js";
import {
  IMMEDIATE_SCHEDULER,
  type Scheduler,
  TIMERS_SCHEDULER,
} from "../../src/github/scheduler.js";
import { api, restoreFetch, stubFetch, traceIo } from "./stub.js";

afterEach(restoreFetch);

const okJson = () =>
  new Response('{"ok":true}', { headers: { "content-type": "application/json" } });

const rateLimited = () =>
  new Response('{"message":"rate limited"}', {
    status: 429,
    headers: { "retry-after": "0", "x-ratelimit-remaining": "0" },
  });

describe("retry and throttling", () => {
  test("429 rate limits are retried until they succeed", async () => {
    const state = stubFetch([rateLimited, rateLimited, okJson]);
    const result = await api().tryRequest("GET", "/rate-limited");
    expect(state.calls).toBe(3);
    expect("data" in result && result.data).toEqual({ ok: true });
  });

  test("5xx is retried; success on a later attempt", async () => {
    const state = stubFetch([() => new Response("bad gateway", { status: 502 }), okJson]);
    const result = await api().tryRequest("GET", "/flaky");
    expect(state.calls).toBe(2);
    expect("data" in result && result.data).toEqual({ ok: true });
  }, 10_000); // The retry plugin's backoff is a fixed ~1s for the first retry.

  test("every attempt leaves a trace line carrying GitHub's request id", async () => {
    // The request-log plugin writes one line per attempt, failed attempts included, with the x-github-request-id support asks for; removing
    // `requestLog` from the plugin list loses exactly these lines while every request still succeeds.
    const withId = (id: string, status: number, body: string | null) =>
      new Response(body, {
        status,
        headers: { "x-github-request-id": id, "content-type": "application/json" },
      });
    stubFetch([() => withId("A1:FAIL", 502, null), () => withId("A2:OK", 200, '{"ok":true}')]);
    const trace = traceIo();
    const result = await api(trace.io).tryRequest("GET", "/repos/o/r/flaky");
    expect("data" in result && result.data).toEqual({ ok: true });
    const attempts = trace.lines
      .filter((line) => line.includes(" with id "))
      .map((line) => line.replace(/ in \d+ms$/, ""));
    expect(attempts).toEqual([
      "GET /repos/o/r/flaky - 502 with id A1:FAIL",
      "GET /repos/o/r/flaky - 200 with id A2:OK",
    ]);
  }, 10_000);

  test("permission 403 (rate limit not exhausted) is NOT retried", async () => {
    const state = stubFetch([
      () =>
        new Response('{"message":"Forbidden"}', {
          status: 403,
          headers: { "x-ratelimit-remaining": "42" },
        }),
    ]);
    const result = await api().tryRequest("GET", "/denied");
    expect(state.calls).toBe(1);
    expect("error" in result && result.error.status).toBe(403);
  });

  test("4xx client errors are never retried", async () => {
    const state = stubFetch([
      () => new Response('{"message":"Validation Failed"}', { status: 422 }),
    ]);
    const result = await api().tryRequest("PUT", "/bad-payload", { nope: true });
    expect(state.calls).toBe(1);
    expect("error" in result && result.error.status).toBe(422);
  });

  test("exhausted rate-limit retries surface the API message", async () => {
    const state = stubFetch([rateLimited]);
    const result = await api().tryRequest("GET", "/hopeless");
    expect(state.calls).toBe(1 + MAX_RETRIES);
    expect("error" in result && result.error.status).toBe(429);
    // No JSON content-type on the stubbed body, so the raw text is the message.
    expect("error" in result && result.error.message).toBe('{"message":"rate limited"}');
  });

  test("a rate-limit reset beyond the 60s cap fails now instead of stalling", async () => {
    // The throttling plugin derives the wait from x-ratelimit-reset; an hour-away reset must fail loudly, not stall.
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    const state = stubFetch([
      () =>
        new Response('{"message":"rate limited"}', {
          status: 429,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
        }),
    ]);
    const result = await api().tryRequest("GET", "/long-reset");
    expect(state.calls).toBe(1);
    expect("error" in result && result.error.status).toBe(429);
  });

  test("network failure exhausts retries, then explains connectivity", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(api().tryRequest("GET", "/down")).rejects.toThrow("Check network connectivity");
  }, 20_000); // Two fixed-backoff retries (~1s + ~4s) before the final failure.
});

describe("RETRY_BASE_MS: millisecond units and the immediate scheduler, same plugin topology", () => {
  const saved = process.env.RETRY_BASE_MS;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.RETRY_BASE_MS;
    } else {
      process.env.RETRY_BASE_MS = saved;
    }
  });

  /** An immediate scheduler whose every Group logs `<name>:<group id>` on schedule, so a test can see whose groups served a request. */
  function recordingScheduler(name: string, served: string[]): Scheduler {
    class RecordingGroup {
      private readonly inner: InstanceType<Scheduler["Group"]>;
      constructor(private readonly options: { id: string }) {
        this.inner = new IMMEDIATE_SCHEDULER.Group(options);
      }
      key(id: string) {
        const limiter = this.inner.key(id);
        return {
          on: (event: string, handler: Parameters<typeof limiter.on>[1]) =>
            limiter.on(event, handler),
          schedule: (...call: unknown[]) => {
            served.push(`${name}:${this.options.id}`);
            return limiter.schedule(...call);
          },
        };
      }
    }
    class RecordingLimiter {
      static Group = RecordingGroup;
      static Events = IMMEDIATE_SCHEDULER.Events;
      private readonly inner = new IMMEDIATE_SCHEDULER();
      on(event: string, handler: Parameters<InstanceType<Scheduler>["on"]>[1]) {
        return this.inner.on(event, handler);
      }
      schedule(...call: unknown[]) {
        return this.inner.schedule(...call);
      }
    }
    return RecordingLimiter;
  }

  /** Constructed WITHOUT retryBaseMs so the client reads the env exactly as the spawned e2e bundle does. */
  const envKnobClient = (io: ReturnType<typeof traceIo>["io"]) =>
    new GithubApi({ token: "t", io, baseUrl: "https://api.test", apiVersion: "2022-11-28" });

  test("many writes complete without the write limiter's ~1s spacing", async () => {
    process.env.RETRY_BASE_MS = "1";
    stubFetch([() => new Response(null, { status: 204 })]);
    const client = envKnobClient(traceIo().io);
    const started = Date.now();
    for (let i = 0; i < 12; i++) {
      await client.tryRequest("PATCH", `/repos/o/r${i}`, { i });
    }
    // Production spacing floors at ~11s, so 8s discriminates; the band is wide because a loaded machine starves even stubbed awaits for seconds (2s
    // flaked under parallel gate runs).
    expect(Date.now() - started).toBeLessThan(8000);
  }, 30_000); // Lets a broken (production-spaced, ~11s) run reach the elapsed assertion.

  const secondaryLimit = (retryAfter: string) => () =>
    new Response('{"message":"You have exceeded a secondary rate limit. Please wait."}', {
      status: 429,
      headers: { "retry-after": retryAfter, "x-ratelimit-remaining": "0" },
    });

  test("a 429 is recovered by the throttling plugin under the immediate scheduler the knob selects", async () => {
    // The retry plugin never sees a 429 (doNotRetry) and would ignore Retry-After if it did; only the throttling plugin's callback writes this
    // trace line, so the line pins which plugin owned the recovery. No Bottleneck group serving a request pins that the knob selected the
    // immediate scheduler, with no clock involved (the retry plugin schedules through a bare Bottleneck of its own, never a group).
    process.env.RETRY_BASE_MS = "50";
    const state = stubFetch([secondaryLimit("60"), okJson]);
    const trace = traceIo();
    const timers = spyOn(TIMERS_SCHEDULER.Group.prototype, "key");
    try {
      const result = await envKnobClient(trace.io).tryRequest("GET", "/rl");
      expect(state.calls).toBe(2);
      expect("data" in result && result.data).toEqual({ ok: true });
      expect(trace.lines).toContain(
        `secondary rate limit on GET /rl; retry 1/${MAX_RETRIES} after 60s`,
      );
      expect(timers).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
    }
  }, 10_000); // Lets a broken (timer-paced, 3s) run reach the assertion.

  test("each client is paced by its own scheduler's groups, whichever scheduler came first", async () => {
    // The plugin's shared groups are module singletons built from the first client's scheduler unless every group is passed in. Each
    // recording scheduler is a distinct class, so an issue create (write + notification + global) logs which scheduler's groups served it.
    const served: string[] = [];
    const issueCreate = async (name: string) => {
      stubFetch([() => new Response('{"number":1}', { status: 201 })]);
      const client = new GithubApi({
        token: "t",
        io: traceIo().io,
        baseUrl: "https://api.test",
        retryBaseMs: 1,
        scheduler: recordingScheduler(name, served),
      });
      await client.tryRequest("POST", "/repos/o/r/issues", { title: "a" });
    };
    await issueCreate("first");
    await issueCreate("second");
    expect(served).toEqual([
      "first:octokit-write",
      "first:octokit-notifications",
      "first:octokit-global",
      "second:octokit-write",
      "second:octokit-notifications",
      "second:octokit-global",
    ]);
  });

  test("the scheduler alone decides whether Retry-After is slept: immediate at production units, timers at knob units", async () => {
    const recover = async (
      retryAfter: string,
      options: { retryBaseMs: number; scheduler: Scheduler },
    ) => {
      const state = stubFetch([secondaryLimit(retryAfter), okJson]);
      const trace = traceIo();
      const started = Date.now();
      const client = new GithubApi({
        token: "t",
        io: trace.io,
        baseUrl: "https://api.test",
        ...options,
      });
      const result = await client.tryRequest("GET", "/rl");
      expect(state.calls).toBe(2);
      expect("data" in result && result.data).toEqual({ ok: true });
      expect(trace.lines).toContain(
        `secondary rate limit on GET /rl; retry 1/${MAX_RETRIES} after ${retryAfter}s`,
      );
      return Date.now() - started;
    };
    // Production units (a 30s header) under the immediate scheduler: the plugin still asks for the retry, nothing sleeps.
    expect(await recover("30", { retryBaseMs: 1000, scheduler: IMMEDIATE_SCHEDULER })).toBeLessThan(
      5000,
    );
    // Real timers at 5ms units: the plugin's 60-unit wait is a real 300ms. Scheduling overhead alone measured under 40ms,
    // so a run that skipped the wait stays far below the floor.
    expect(
      await recover("60", { retryBaseMs: 5, scheduler: TIMERS_SCHEDULER }),
    ).toBeGreaterThanOrEqual(250);
  });

  test("a 429 whose Retry-After exceeds the wait cap fails at once instead of being retried blind", async () => {
    process.env.RETRY_BASE_MS = "1";
    const state = stubFetch([secondaryLimit(String(MAX_RETRY_WAIT_S + 1)), okJson]);
    const result = await envKnobClient(traceIo().io).tryRequest("GET", "/rl");
    expect(state.calls).toBe(1);
    expect("error" in result && result.error).toMatchObject({ status: 429, rateLimited: true });
  });
});

describe("response shaping", () => {
  test("204/empty bodies come back as null", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const result = await api().tryRequest("DELETE", "/gone");
    expect("data" in result && result.data).toBeNull();
  });

  test("raw option returns the body text untouched", async () => {
    stubFetch([() => new Response("repository:\n  has_wiki: false\n")]);
    const result = await api().tryRequest("GET", "/repos/o/r/contents/x.yml", undefined, {
      accept: "application/vnd.github.raw+json",
      raw: true,
    });
    expect("data" in result && result.data).toBe("repository:\n  has_wiki: false\n");
  });
});

describe("error classification", () => {
  test("rate-limit 403s are rate limits, not permission errors", () => {
    const limited = { status: 403, message: "API rate limit exceeded for user", body: "" };
    expect(isRateLimitError(limited)).toBe(true);
    expect(isPermissionError(limited)).toBe(false);
    const denied = { status: 403, message: "Resource not accessible", body: "" };
    expect(isRateLimitError(denied)).toBe(false);
    expect(isPermissionError(denied)).toBe(true);
  });

  test("a 403 with retry-after classifies structurally even without the phrase", async () => {
    // The body never says "rate limit", so only the retry-after header (which no documented non-limit 403 carries) proves the classification.
    // Misreading it as a missing grant would hand out permission advice and, under on-missing-permission: warn, silently skip the section.
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json", "retry-after": "30" },
        }),
    ]);
    const result = await api().tryRequest("GET", "/repos/o/r/labels");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.rateLimited).toBe(true);
    expect(isRateLimitError(result.error)).toBe(true);
    expect(isPermissionError(result.error)).toBe(false);
    // The common (non-secret) path keeps its diagnostic body.
    expect(result.error.message).toBe("Forbidden");
  });

  test("an exhausted primary limit classifies through its message, zero header or not", async () => {
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded for user" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
        }),
    ]);
    const result = await api().tryRequest("GET", "/repos/o/r/labels");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(isRateLimitError(result.error)).toBe(true);
    expect(isPermissionError(result.error)).toBe(false);
  });

  test("a permission 403 on the token's LAST quota unit stays a permission error", async () => {
    // x-ratelimit-remaining: 0 alone is ambiguous: a genuine denial on the last quota unit carries it too. The readable message disambiguates, so the
    // zero header must contribute nothing here.
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
        }),
    ]);
    const result = await api().tryRequest("GET", "/repos/o/r/labels");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.rateLimited).toBeUndefined();
    expect(isRateLimitError(result.error)).toBe(false);
    expect(isPermissionError(result.error)).toBe(true);
  });

  test("a plain permission 403 stays a permission error (no structural signal)", async () => {
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "42" },
        }),
    ]);
    const result = await api().tryRequest("GET", "/repos/o/r/labels");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.rateLimited).toBeUndefined();
    expect(isRateLimitError(result.error)).toBe(false);
    expect(isPermissionError(result.error)).toBe(true);
  });
});

describe("error body shaping", () => {
  test("documentation_url survives into the ApiError", async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            message: "Validation Failed",
            errors: [{ field: "rules", message: "Invalid rule" }],
            documentation_url: "https://docs.github.com/rest/repos/rules",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    ]);
    const result = await api().tryRequest("POST", "/repos/o/r/rulesets", { rules: [] });
    expect("error" in result && result.error.documentationUrl).toBe(
      "https://docs.github.com/rest/repos/rules",
    );
    expect("error" in result && result.error.message).toBe(
      'Validation Failed ([{"field":"rules","message":"Invalid rule"}])',
    );
  });

  test("string and empty bodies leave documentationUrl unset", async () => {
    stubFetch([() => new Response("plain text failure", { status: 422 })]);
    const result = await api().tryRequest("POST", "/repos/o/r/rulesets", {});
    expect("error" in result && result.error.documentationUrl).toBeUndefined();
    expect("error" in result && result.error.message).toBe("plain text failure");
  });
});

describe("debug-trace hardening for redacted slugs", () => {
  // Every test reads the debug lines its OWN trace facet received, so a concurrent test's output cannot pollute the observation.

  test("a slug masked through the Io port is redacted from the trace with no second registration", async () => {
    const dbg = traceIo();
    dbg.io.mask("o/priv");
    stubFetch([() => new Response(null, { status: 204 })]);
    await api(dbg.io).tryRequest("PATCH", "/repos/o/priv", { description: "CANARY" });
    const trace = dbg.lines.join("");
    expect(trace).toContain("PATCH <redacted> ->");
    expect(trace).not.toContain("o/priv");
    expect(trace).not.toContain("CANARY");
    expect(trace).not.toContain("payload:");
  });

  test("a masked non-slug value collapses an octokit line; an empty mask matches nothing", () => {
    const dbg = traceIo();
    dbg.io.mask("s3cret-plaintext");
    dbg.io.mask("");
    const log = redactingOctokitLog(new TraceRedaction(dbg.io));
    log.info("retrying s3cret-plaintext after 429");
    log.info("GET /repos/o/publicrepo - 200 in 1ms");
    expect(dbg.lines).toEqual(["<redacted>", "GET /repos/o/publicrepo - 200 in 1ms"]);
  });

  test("a masked slug's trace collapses the whole path and drops the payload", async () => {
    const dbg = traceIo();
    dbg.io.mask("o/secretrepo");
    stubFetch([() => new Response(null, { status: 204 })]);
    await api(dbg.io).tryRequest("PATCH", "/repos/o/secretrepo", { description: "CANARY-live" });
    const trace = dbg.lines.join("");
    expect(trace).toContain("PATCH <redacted> ->");
    expect(trace).not.toContain("o/secretrepo");
    expect(trace).not.toContain("CANARY-live");
    expect(trace).not.toContain("payload:");
  });

  test("a team-repo route redacts its PREFIX too (no team slug leak)", async () => {
    // The team slug rides in the prefix before /repos/, so truncating to /repos/<redacted> would leak it.
    const dbg = traceIo();
    dbg.io.mask("acme/private");
    stubFetch([() => new Response(null, { status: 204 })]);
    await api(dbg.io).tryRequest("PUT", "/orgs/acme/teams/secret-team/repos/acme/private", {
      permission: "push",
    });
    const trace = dbg.lines.join("");
    expect(trace).toContain("PUT <redacted> ->");
    expect(trace).not.toContain("secret-team");
    expect(trace).not.toContain("acme/private");
  });

  test("an unregistered slug traces normally, with its payload", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = traceIo();
    await api(dbg.io).tryRequest("PATCH", "/repos/o/publicrepo", { description: "open" });
    const trace = dbg.lines.join("");
    expect(trace).toContain("/repos/o/publicrepo");
    expect(trace).toContain("payload:");
  });

  test("redactingOctokitLog routes redacted content to the debug channel and never to stderr", () => {
    // The leak class the fuzz stderr scan found: octokit's plugins log request lines (with live-state segments like branch names) to stderr via the
    // default console logger.
    const dbg = traceIo();
    dbg.io.mask("e2e-owner/repo-1");
    const log = redactingOctokitLog(new TraceRedaction(dbg.io));
    let stderrWrites = 0;
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => {
      stderrWrites += 1;
      return true;
    });
    try {
      for (const level of ["debug", "info", "warn", "error"] as const) {
        log[level]("PUT /repos/e2e-owner/repo-1/branches/dev-secret/protection - 403 in 3ms");
      }
      // The gap a path-only redactor misses: the slug outside /repos/ position, as the retry/throttle plugins' free-text prose puts it.
      log.warn("retrying request to e2e-owner/repo-1 after 429");
      log.debug("GET /repos/e2e-owner/repo-1 - 200 with id undefined in 3ms");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(stderrWrites).toBe(0);
    expect(dbg.lines).toEqual(Array(6).fill("<redacted>"));
  });

  test("redactingOctokitLog leaves an unmasked slug's line intact", () => {
    const dbg = traceIo();
    redactingOctokitLog(new TraceRedaction(dbg.io)).warn("GET /repos/o/publicrepo - 200 in 1ms");
    expect(dbg.lines).toEqual(["GET /repos/o/publicrepo - 200 in 1ms"]);
  });

  test("redactingOctokitLog redacts a MIXED-CASE octokit line, slug outside /repos/ position", () => {
    // Octokit does not normalize case, so a slug in another case and mid-sentence must still collapse the line.
    const dbg = traceIo();
    dbg.io.mask("e2e-owner/svc-private");
    const log = redactingOctokitLog(new TraceRedaction(dbg.io));
    log.warn("retrying E2E-Owner/SVC-Private after 429 (attempt 2)");
    log.debug("GET /REPOS/E2E-OWNER/SVC-PRIVATE - 200 with id undefined in 3ms");
    expect(dbg.lines).toEqual(["<redacted>", "<redacted>"]);
  });

  test("redactTrace holds the slug for the request only; the same client traces it legibly afterwards", async () => {
    // The visibility probe must not leak its target before the answer is known; once the flow decided it is public, the same slug is legible again.
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = traceIo();
    const client = api(dbg.io);
    await client.tryRequest("GET", "/repos/owner/probed", undefined, { redactTrace: true });
    // Octokit's own request lines ride the same channel, so the whole window must stay free of the slug.
    const held = dbg.lines.join("\n");
    expect(held).toContain("GET <redacted> -> 204");
    expect(held).not.toContain("owner/probed");
    dbg.lines.length = 0;
    await client.tryRequest("GET", "/repos/owner/probed");
    expect(dbg.lines.join("\n")).toContain("GET /repos/owner/probed -> 204");
    // A hold needs a slug to hold: a slug-free path cannot be traced redacted.
    await expect(
      client.tryRequest("GET", "/user", undefined, { redactTrace: true }),
    ).rejects.toThrow(/redactTrace needs a/);
  });

  test("a rate-limited visibility probe leaks no raw slug in any trace", async () => {
    // The throttle-callback trace fires on the 429 retry, before the probe result exists, so the probe's request-window hold is what redacts it.
    const { createVisibilityResolver } = await import("../../src/github/repo-visibility.js");
    stubFetch([
      rateLimited,
      () => new Response('{"private":true}', { headers: { "content-type": "application/json" } }),
    ]);
    const dbg = traceIo();
    expect(await createVisibilityResolver(api(dbg.io))("secret-owner/secret-repo")).toBe("private");
    const trace = dbg.lines.join("");
    expect(trace).not.toContain("secret-repo");
    expect(trace).toContain("rate limit on GET <redacted>");
  });
});

describe("withheld() rebuilds from the allowlist", () => {
  const base = { status: 422, message: "echo: CANARY", body: '{"echo":"CANARY"}' };
  const rebuilt = { status: 422, message: "withheld reason", body: "withheld reason" };
  const rebuiltRateLimited = { ...rebuilt, rateLimited: true };

  // Each shape smuggles CANARY past a different field FILTER (spread, copy loop, for..in); only a rebuild that names its fields drops them all.
  // rateLimited: true anywhere on the input, own or inherited, is the one field that survives beside the status.
  test.each([
    [
      "extra fields",
      { ...base, documentationUrl: "https://docs/CANARY", extra: "CANARY" } as ApiError,
      rebuilt,
    ],
    [
      "nested objects",
      { ...base, rateLimited: true, nested: { deep: "CANARY" } } as ApiError,
      rebuiltRateLimited,
    ],
    ["a toJSON hook", { ...base, toJSON: () => ({ leak: "CANARY" }) } as ApiError, rebuilt],
    [
      "an enumerable getter",
      Object.defineProperty({ ...base }, "leak", {
        get: () => "CANARY",
        enumerable: true,
      }) as ApiError,
      rebuilt,
    ],
    [
      "prototype-chain properties",
      Object.assign(Object.create({ inherited: "CANARY", rateLimited: true }), base) as ApiError,
      rebuiltRateLimited,
    ],
  ])(
    "the output carries ONLY allowlisted own data fields against %s",
    (_shape, error, expected) => {
      const out = withheld(error, "withheld reason");
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect([...Reflect.ownKeys(out)].sort()).toEqual(Object.keys(expected).sort());
      expect(out).toEqual(expected);
      for (const key of Reflect.ownKeys(out)) {
        const descriptor = Object.getOwnPropertyDescriptor(out, key);
        expect(descriptor?.get).toBeUndefined();
      }
      expect(JSON.stringify(out)).not.toContain("CANARY");
      let inherited = 0;
      for (const _key in out) {
        inherited += 1;
      }
      expect(inherited).toBe(Object.keys(out).length);
    },
  );

  test("the classification fields survive as fresh values; anything falsy or absent is dropped", () => {
    const types = Object.freeze(["FORBIDDEN", "NOT_FOUND"]);
    const kept = withheld(
      { status: 403, message: "m", body: "b", rateLimited: true, graphqlTypes: types },
      "r",
    );
    expect(kept).toEqual({
      status: 403,
      message: "r",
      body: "r",
      rateLimited: true,
      graphqlTypes: ["FORBIDDEN", "NOT_FOUND"],
    });
    expect(kept.graphqlTypes).not.toBe(types);
    expect(Object.isFrozen(kept.graphqlTypes)).toBe(true);
    const dropped = withheld(
      { status: 403, message: "m", body: "b", rateLimited: "yes" as unknown as true },
      "r",
    );
    expect(dropped).toEqual({ status: 403, message: "r", body: "r" });
    // A type list smuggling free text, or a non-string that merely prints as a token, loses the WHOLE field, not just the entry.
    const smuggled = withheld(
      { status: 404, message: "m", body: "b", graphqlTypes: ["NOT_FOUND", "o/CANARY"] },
      "r",
    );
    expect(smuggled).toEqual({ status: 404, message: "r", body: "r" });
    const disguised = withheld(
      {
        status: 404,
        message: "m",
        body: "b",
        graphqlTypes: [{ leak: "CANARY", toString: () => "FORBIDDEN" }] as unknown as string[],
      },
      "r",
    );
    expect(disguised).toEqual({ status: 404, message: "r", body: "r" });
  });
});

describe("secret-field request redaction and fail-closed error responses", () => {
  // The hookco/hookrepo slug keeps these traces independent of slug redaction: a slug hit would collapse the whole line before the field-level
  // assertions could see anything.

  function stubFetchCapturingBodies(response: () => Response): { bodies: string[] } {
    const state = { bodies: [] as string[] };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      state.bodies.push(String(init?.body ?? ""));
      return response();
    }) as unknown as typeof fetch;
    return state;
  }

  // Hostile to exact-literal masking: JSON escaping turns the quotes, backslash, and newline into \" \\ \n, so no literal scan for the original
  // string finds the echo.
  const hostileSecret = 'he said "no" \\ back\nslash';

  // The fixed tail of every unsent-payload abort, after the scan's reason clause.
  const NOT_SENT_TAIL =
    ", so it could not be safely inspected for secret fields. Replace that value with a plain string in the settings file";
  // The reason when the scan has no typed rejection to name a field with: a hostile proxy, a bare bigint, a cycle.
  const NOT_PLAIN_FALLBACK =
    "its payload is not plain JSON data (a cyclic value, or a value carrying a function or exotic prototype)";

  test("config.secret is masked in the trace; the outgoing request is untouched", async () => {
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = traceIo();
    await api(dbg.io).tryRequest("POST", "/repos/hookco/hookrepo/hooks", {
      name: "web",
      config: { url: "https://example.test/hook", content_type: "json", secret: hostileSecret },
    });
    const trace = dbg.lines.join("");
    expect(trace).toContain('"secret":"***"');
    expect(trace).not.toContain("he said");
    expect(trace).toContain('"url":"https://example.test/hook"');
    expect(sent.bodies).toEqual([
      JSON.stringify({
        name: "web",
        config: { url: "https://example.test/hook", content_type: "json", secret: hostileSecret },
      }),
    ]);
  });

  test("encrypted_value is masked in the trace", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = traceIo();
    await api(dbg.io).tryRequest("PUT", "/repos/hookco/hookrepo/actions/secrets/DEPLOY_KEY", {
      encrypted_value: "base64-SECRET-material",
      key_id: "568250167242549743",
    });
    const trace = dbg.lines.join("");
    expect(trace).toContain('"encrypted_value":"***"');
    expect(trace).not.toContain("base64-SECRET-material");
    expect(trace).toContain('"key_id":"568250167242549743"');
  });

  test("a 422 echoing the secret is replaced wholesale; only the status survives", async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            message: `Validation Failed: secret ${hostileSecret} is too weak`,
            errors: [{ resource: "Hook", field: "secret", value: hostileSecret }],
            documentation_url: "https://docs.github.com/rest/repos/webhooks",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    ]);
    const dbg = traceIo();
    const result = await api(dbg.io).tryRequest("POST", "/repos/hookco/hookrepo/hooks", {
      name: "web",
      config: { url: "https://example.test/hook", secret: hostileSecret },
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.status).toBe(422);
    expect(result.error.documentationUrl).toBeUndefined();
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(SECRET_RESPONSE_WITHHELD);
    for (const fragment of ["he said", "back", "slash", "too weak", "Hook"]) {
      expect(result.error.message).not.toContain(fragment);
      expect(result.error.body).not.toContain(fragment);
    }
    expect(dbg.lines.join("")).not.toContain("he said");
  });

  test("a hostile documentation_url carrying the secret cannot ride out", async () => {
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            message: "Bad Request",
            documentation_url: `https://docs.github.com/${hostileSecret}`,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    ]);
    const result = await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
      url: "https://example.test/hook",
      secret: hostileSecret,
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.documentationUrl).toBeUndefined();
    expect(JSON.stringify(result.error)).not.toContain("he said");
  });

  test("a TOP-LEVEL secret (the hook config sub-endpoint shape) is masked and fail-closed", async () => {
    // PATCH /hooks/{id}/config sends the config object bare, so `secret` sits at the top level.
    const sent = stubFetchCapturingBodies(
      () => new Response(`nope: ${hostileSecret}`, { status: 400 }),
    );
    const dbg = traceIo();
    const result = await api(dbg.io).tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
      url: "https://example.test/hook",
      content_type: "json",
      secret: hostileSecret,
    });
    const trace = dbg.lines.join("");
    expect(trace).toContain('"secret":"***"');
    expect(trace).not.toContain("he said");
    expect(sent.bodies).toEqual([
      JSON.stringify({
        url: "https://example.test/hook",
        content_type: "json",
        secret: hostileSecret,
      }),
    ]);
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(SECRET_RESPONSE_WITHHELD);
  });

  test("a secret field at any depth is found - the scan is recursive, not shape-listed", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = traceIo();
    await api(dbg.io).tryRequest("POST", "/repos/hookco/hookrepo/anything", {
      outer: { hooks: [{ config: { secret: hostileSecret } }, { note: "clean" }] },
    });
    const trace = dbg.lines.join("");
    expect(trace).toContain('"secret":"***"');
    expect(trace).toContain('"note":"clean"');
    expect(trace).not.toContain("he said");
  });

  test("config.encrypted_value nested under config is masked too", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = traceIo();
    await api(dbg.io).tryRequest("PUT", "/repos/hookco/hookrepo/anything", {
      config: { encrypted_value: "base64-SECRET", key_id: "1" },
    });
    const trace = dbg.lines.join("");
    expect(trace).toContain('"encrypted_value":"***"');
    expect(trace).not.toContain("base64-SECRET");
  });

  test("a transport failure on a secret-carrying request withholds the error detail", async () => {
    globalThis.fetch = (async () => {
      throw new Error(`request to https://x failed, body was: {"secret":"${hostileSecret}"}`);
    }) as unknown as typeof fetch;
    let thrown: Error | undefined;
    try {
      await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
        url: "https://example.test/hook",
        secret: hostileSecret,
      });
    } catch (error) {
      thrown = error as Error;
    }
    if (thrown === undefined) {
      throw new Error("expected a thrown transport error");
    }
    expect(thrown.message).toBe(
      "PATCH /repos/hookco/hookrepo/hooks/1/config failed: the transport failed before an HTTP " +
        "response arrived (details withheld: the request carried a secret field). Check network " +
        "connectivity from the runner to https://api.test, then re-run the workflow",
    );
  });

  test("a transport failure on a non-secret request keeps its diagnostic message", async () => {
    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    let thrown: Error | undefined;
    try {
      await api().tryRequest("GET", "/repos/hookco/hookrepo", undefined);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(
      "GET /repos/hookco/hookrepo failed: socket hang up. Check network connectivity from the runner to https://api.test, then re-run the workflow",
    );
  });

  test("a secret-carrying 403 rate limit still classifies as a rate limit", async () => {
    // The wholesale replacement destroys the message isRateLimitError reads, so the content-free flag must carry the classification;
    // apiErrorFromHttp classifies on the original body before replacing it.
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            message: `You have exceeded a secondary rate limit (echo: ${hostileSecret})`,
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "retry-after": "60",
              "x-ratelimit-remaining": "42",
            },
          },
        ),
    ]);
    const result = await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
      url: "https://example.test/hook",
      secret: hostileSecret,
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(SECRET_RESPONSE_WITHHELD);
    expect(isRateLimitError(result.error)).toBe(true);
    expect(JSON.stringify(result.error)).not.toContain("he said");
  });

  test("a WITHHELD 403 with only the zero-quota header still reads as a rate limit", async () => {
    // With the message destroyed, the ambiguous x-ratelimit-remaining: 0 is accepted on this path only: the lesser evil against telling a
    // rate-limited user to fix their token.
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: `denied (echo: ${hostileSecret})` }), {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
        }),
    ]);
    const result = await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
      url: "https://example.test/hook",
      secret: hostileSecret,
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(isRateLimitError(result.error)).toBe(true);
  });

  test("an echoed 'rate limit' string cannot spoof the classification", async () => {
    // The classification uses the throttling plugin's exact phrase (\bsecondary rate\b), so a body merely echoing "rate limit" without rate-limit
    // headers stays a permission failure.
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: "rate limit rate limit rate limit" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "42" },
        }),
    ]);
    const result = await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
      url: "https://example.test/hook",
      secret: hostileSecret,
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(isRateLimitError(result.error)).toBe(false);
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
  });

  test("a HEADERLESS secondary rate limit (message-only) still classifies as one", async () => {
    // GitHub documents secondary limits with neither x-ratelimit-remaining nor retry-after; misreading one as a permission failure would tell the
    // user to fix their PAT, or silently skip the section under on-missing-permission: warn.
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const result = await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
      url: "https://example.test/hook",
      secret: hostileSecret,
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(isRateLimitError(result.error)).toBe(true);
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
  });

  test("errors[].type RATE_LIMITED classifies without headers or message text", async () => {
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: "Forbidden", errors: [{ type: "RATE_LIMITED" }] }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const result = await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
      url: "https://example.test/hook",
      secret: hostileSecret,
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(isRateLimitError(result.error)).toBe(true);
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
  });

  // The hand-rolled normalization never consults toJSON and rejects a function-valued property, so every shape aborts unsent.
  // calls === 0 is the proof: a stringify-based normalization would have invoked toJSON, and a stateful one could show the scan a clean object and
  // the wire the secret.
  const hostileToJson: Array<[string, (record: () => void) => unknown]> = [
    [
      // A collapse to a primitive would dodge the field-name scan entirely.
      "collapsing the payload to a primitive",
      (record) => ({
        note: "clean-looking",
        toJSON(): unknown {
          record();
          return `flattened: ${hostileSecret}`;
        },
      }),
    ],
    [
      "returning null",
      (record) => ({
        toJSON(): unknown {
          record();
          return null;
        },
      }),
    ],
    [
      "returning clean output first and the secret later",
      (record) => {
        let serializations = 0;
        return {
          note: "looks-clean",
          toJSON(): unknown {
            record();
            serializations++;
            return serializations === 1
              ? { note: "looks-clean" }
              : { note: "looks-clean", secret: hostileSecret };
          },
        };
      },
    ],
    [
      // The sharpest shape: the secret under no field name at all, where a stringify scan would trace it verbatim.
      "hiding the secret in a renamed container",
      (record) => ({
        secret: hostileSecret,
        toJSON(): unknown {
          record();
          return [hostileSecret];
        },
      }),
    ],
    [
      // The field exists only in toJSON's output; a stringify-based normalization would have to mask it after the fact.
      "smuggling a secret field into clean-looking output",
      (record) => ({
        note: "clean-looking",
        toJSON(): unknown {
          record();
          return { note: "clean-looking", secret: hostileSecret };
        },
      }),
    ],
  ];
  test.each(hostileToJson)(
    "a toJSON %s aborts - toJSON is never consulted",
    async (_shape, makePayload) => {
      let calls = 0;
      const payload = makePayload(() => {
        calls++;
      });
      const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
      const dbg = traceIo();
      let thrown: Error | undefined;
      try {
        await api(dbg.io).tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", payload);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).toBe(
        `PATCH /repos/hookco/hookrepo/hooks/1/config was not sent: the value at "toJSON" is not plain JSON data (a function)${NOT_SENT_TAIL}`,
      );
      expect(calls).toBe(0);
      expect(sent.bodies).toHaveLength(0);
      expect(dbg.lines.join("")).not.toContain("he said");
    },
  );

  test("a proxy with a throwing getPrototypeOf trap aborts without leaking its error", async () => {
    // The reflective container check itself throws on this proxy; the fail-closed path must catch it rather than let the trap's message escape.
    const hostileProxy = new Proxy(
      { url: "https://example.test" },
      {
        getPrototypeOf(): object | null {
          throw new Error(hostileSecret);
        },
      },
    );
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    let thrown: Error | undefined;
    try {
      await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", hostileProxy);
    } catch (error) {
      thrown = error as Error;
    }
    // The trap's throw is swallowed: no field name, so the fallback reason.
    expect(thrown?.message).toBe(
      `PATCH /repos/hookco/hookrepo/hooks/1/config was not sent: ${NOT_PLAIN_FALLBACK}${NOT_SENT_TAIL}`,
    );
    expect(sent.bodies).toHaveLength(0);
  });

  test("an accessor property is rejected unread - its getter never runs", async () => {
    // A getter is code, not data: even one returning clean data could sabotage globals, so descriptors reject it uninvoked.
    let getterRan = false;
    const trapped = {
      url: "https://example.test",
      get note(): string {
        getterRan = true;
        return "innocent";
      },
    };
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    let thrown: Error | undefined;
    try {
      await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", trapped);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(
      `POST /repos/hookco/hookrepo/anything was not sent: the value at "note" is not plain JSON data (an accessor property)${NOT_SENT_TAIL}`,
    );
    expect(getterRan).toBe(false);
    expect(sent.bodies).toHaveLength(0);
  });

  test("an array subclass with an overridden map is rejected, its code never run", async () => {
    // .map on a subclass dispatches to the override, foreign code that could substitute [secret]; only base-class arrays are plain data and the
    // normalizer iterates by index.
    let overrideRan = false;
    class SneakyArray extends Array<unknown> {
      override map<U>(_fn: (v: unknown, i: number, a: unknown[]) => U): U[] {
        overrideRan = true;
        return [hostileSecret] as unknown as U[];
      }
    }
    const sneaky = SneakyArray.from([{ name: "web" }]);
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    let thrown: Error | undefined;
    try {
      await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", sneaky);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(
      `POST /repos/hookco/hookrepo/anything was not sent: the value is not plain JSON data (a non-plain object)${NOT_SENT_TAIL}`,
    );
    expect(overrideRan).toBe(false);
    expect(sent.bodies).toHaveLength(0);
  });

  test("a YAML !!timestamp value (a Date) reaches the abort with the tag named", async () => {
    // validate.ts already rejects a Date (findNonPlain), so this is the belt under it: the yaml package parses explicit !!timestamp tags to Date
    // objects, and the abort must name the tag.
    const parsed = parseYaml("stamp: !!timestamp 2024-01-01") as Record<string, unknown>;
    expect(parsed.stamp instanceof Date).toBe(true);
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    let thrown: Error | undefined;
    try {
      await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", parsed);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(
      `POST /repos/hookco/hookrepo/anything was not sent: the value at "stamp" is not plain JSON data (a Date, e.g. from a YAML !!timestamp tag)${NOT_SENT_TAIL}`,
    );
    expect(sent.bodies).toHaveLength(0);
  });

  test("a top-level bigint payload aborts instead of reaching octokit", async () => {
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    let thrown: Error | undefined;
    try {
      await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", 42n);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(
      `POST /repos/hookco/hookrepo/anything was not sent: ${NOT_PLAIN_FALLBACK}${NOT_SENT_TAIL}`,
    );
    expect(sent.bodies).toHaveLength(0);
  });

  test("a non-plain-object payload (a Buffer) is never sent", async () => {
    // Octokit passes non-plain objects to fetch verbatim; normalizing one would change the wire and sending it unscanned would be a blind spot, so it
    // aborts. Nothing sends such a payload today; this pins the boundary.
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    let thrown: Error | undefined;
    try {
      await api().tryRequest(
        "POST",
        "/repos/hookco/hookrepo/anything",
        Buffer.from("raw-bytes-here"),
      );
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(
      `POST /repos/hookco/hookrepo/anything was not sent: the value is not plain JSON data (a non-plain object)${NOT_SENT_TAIL}`,
    );
    expect(sent.bodies).toHaveLength(0);
  });

  test("a secret-carrying plain 403 stays a permission failure, not a rate limit", async () => {
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const result = await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
      url: "https://example.test/hook",
      secret: hostileSecret,
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(isRateLimitError(result.error)).toBe(false);
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
  });

  test("a payload the scan cannot walk is never sent at all", async () => {
    // The getter's error message IS the secret; sending what the scan could not inspect would let a stateful object show the scan one thing and the
    // wire another.
    const boobyTrapped = {
      url: "https://example.test/hook",
      get secret(): string {
        throw new Error(hostileSecret);
      },
    };
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = traceIo();
    let thrown: Error | undefined;
    try {
      await api(dbg.io).tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", boobyTrapped);
    } catch (error) {
      thrown = error as Error;
    }
    if (thrown === undefined) {
      throw new Error("expected a thrown abort");
    }
    expect(thrown.message).toBe(
      `PATCH /repos/hookco/hookrepo/hooks/1/config was not sent: the value at "secret" is not plain JSON data (an accessor property)${NOT_SENT_TAIL}`,
    );
    expect(sent.bodies).toHaveLength(0);
    expect(dbg.lines.join("")).not.toContain("he said");
  });

  test("a cyclic payload aborts, never a stack overflow or a raw trace", async () => {
    const cyclic: Record<string, unknown> = { url: "https://example.test", secret: hostileSecret };
    cyclic.self = cyclic;
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = traceIo();
    let thrown: Error | undefined;
    try {
      await api(dbg.io).tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", cyclic);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(
      `PATCH /repos/hookco/hookrepo/hooks/1/config was not sent: ${NOT_PLAIN_FALLBACK}${NOT_SENT_TAIL}`,
    );
    expect(sent.bodies).toHaveLength(0);
    expect(dbg.lines.join("")).not.toContain("he said");
  });

  test("field-name matching is case-insensitive", async () => {
    // A passthrough payload can carry arbitrary user keys, so a `Secret:` spelling must not slip the scan.
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = traceIo();
    await api(dbg.io).tryRequest("POST", "/repos/hookco/hookrepo/anything", {
      Secret: hostileSecret,
      config: { ENCRYPTED_VALUE: hostileSecret },
    });
    const trace = dbg.lines.join("");
    expect(trace).toContain('"Secret":"***"');
    expect(trace).toContain('"ENCRYPTED_VALUE":"***"');
    expect(trace).not.toContain("he said");
  });

  test("an own __proto__ key survives in the trace instead of vanishing", async () => {
    // JSON.parse creates __proto__ as an own DATA property; a plain {} copy target would hit the prototype setter and drop the branch.
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = traceIo();
    await api(dbg.io).tryRequest(
      "POST",
      "/repos/hookco/hookrepo/anything",
      JSON.parse(`{"__proto__": {"note": "kept"}, "config": {"secret": "s3cret-here"}}`),
    );
    const trace = dbg.lines.join("");
    expect(trace).toContain('"__proto__":{"note":"kept"}');
    expect(trace).toContain('"secret":"***"');
    expect(trace).not.toContain("s3cret-here");
  });

  test("a string-body 403 rate limit on a secret request still classifies as one", async () => {
    stubFetch([
      () =>
        new Response(`You have exceeded a secondary rate limit. ${hostileSecret}`, {
          status: 403,
          headers: { "retry-after": "60" },
        }),
    ]);
    const result = await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
      url: "https://example.test/hook",
      secret: hostileSecret,
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(isRateLimitError(result.error)).toBe(true);
    expect(JSON.stringify(result.error)).not.toContain("he said");
  });

  test("a plain-text error body to an encrypted_value request is withheld too", async () => {
    stubFetch([() => new Response(`rejected: ${hostileSecret}`, { status: 400 })]);
    const result = await api().tryRequest("PUT", "/repos/hookco/hookrepo/actions/secrets/K", {
      encrypted_value: hostileSecret,
      key_id: "1",
    });
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.status).toBe(400);
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(SECRET_RESPONSE_WITHHELD);
    expect(result.error.documentationUrl).toBeUndefined();
  });

  test("a non-secret request's trace and error are unchanged by the scan", async () => {
    const payload = { name: "web", config: { url: "https://example.test", content_type: "json" } };
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            message: "Validation Failed",
            errors: [{ field: "name", message: "bad name" }],
            documentation_url: "https://docs.github.com/rest",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    ]);
    const dbg = traceIo();
    const result = await api(dbg.io).tryRequest("POST", "/repos/hookco/hookrepo/hooks", payload);
    expect(dbg.lines.join("")).toContain(` payload: ${JSON.stringify(payload)}`);
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(
      'Validation Failed ([{"field":"name","message":"bad name"}])',
    );
    expect(result.error.body).toBe(
      '{"message":"Validation Failed","errors":[{"field":"name","message":"bad name"}],"documentation_url":"https://docs.github.com/rest"}',
    );
    expect(result.error.documentationUrl).toBe("https://docs.github.com/rest");
  });
});

describe("DELETE request bodies reach the wire", () => {
  test("a DELETE payload transmits end-to-end through a real HTTP server", async () => {
    // The secret-scanning custom-pattern bulk DELETE is the one endpoint whose DELETE carries a REQUIRED body; octokit/undici dropping it would
    // surface as a 400 only deep in the e2e suite, so the transport property is pinned here against a real server.
    const received: Array<{ method: string; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({ method: request.method, body: await request.text() });
        return new Response(null, { status: 204 });
      },
    });
    try {
      const client = new GithubApi({
        token: "t",
        io: traceIo().io,
        baseUrl: `http://localhost:${server.port}`,
        apiVersion: "2022-11-28",
        retryBaseMs: 1,
      });
      const result = await client.tryRequest(
        "DELETE",
        "/repos/o/r/secret-scanning/custom-patterns",
        {
          patterns: [{ pattern_id: 7, custom_pattern_version: "v2" }],
          post_delete_action: "resolve_alerts",
        },
      );
      expect(result).toEqual({ data: null });
      expect(received).toEqual([
        {
          method: "DELETE",
          body: '{"patterns":[{"pattern_id":7,"custom_pattern_version":"v2"}],"post_delete_action":"resolve_alerts"}',
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });
});

describe("TraceRedaction holds", () => {
  test("overlapping holds on one slug are independent: releasing one, even twice, keeps the other's redaction", () => {
    const trace = new TraceRedaction(traceIo().io);
    const releaseFirst = trace.hold("o/probed");
    const releaseSecond = trace.hold("O/Probed");
    releaseFirst();
    releaseFirst(); // a repeated release must not consume the other hold
    expect(trace.path("/repos/o/probed/labels")).toEqual({ path: "<redacted>", redacted: true });
    expect(trace.message("retrying o/probed after 429")).toBe("<redacted>");
    releaseSecond();
    expect(trace.path("/repos/o/probed/labels")).toEqual({
      path: "/repos/o/probed/labels",
      redacted: false,
    });
    expect(trace.message("retrying o/probed after 429")).toBe("retrying o/probed after 429");
    expect(trace.isRedacted("o/probed")).toBe(false);
  });
});
