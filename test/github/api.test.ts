import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  type ApiError,
  DEFAULT_API_VERSION,
  GitHubApi,
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

  test.each([
    [
      "a permission 403 with rate limit left",
      "GET",
      "/denied",
      undefined,
      () =>
        new Response('{"message":"Forbidden"}', {
          status: 403,
          headers: { "x-ratelimit-remaining": "42" },
        }),
      403,
    ],
    [
      "a 422 on a bad payload",
      "PUT",
      "/bad-payload",
      { nope: true },
      () => new Response('{"message":"Validation Failed"}', { status: 422 }),
      422,
    ],
  ])("%s is never retried", async (_name, method, path, payload, response, status) => {
    const state = stubFetch([response]);
    const result = await api().tryRequest(method, path, payload);
    expect(state.calls).toBe(1);
    expect("error" in result && result.error.status).toBe(status);
  });

  test("exhausted rate-limit retries surface the API message", async () => {
    const state = stubFetch([rateLimited]);
    const result = await api().tryRequest("GET", "/hopeless");
    expect(state.calls).toBe(1 + MAX_RETRIES);
    expect("error" in result && result.error.status).toBe(429);
    // No JSON content-type on the stubbed body, so the raw text is the message, and a string body carries no documentation_url.
    expect("error" in result && result.error.message).toBe('{"message":"rate limited"}');
    expect("error" in result && result.error.documentationUrl).toBeUndefined();
  });
});

describe("GSAC_RETRY_BASE_MS: millisecond units and the immediate scheduler, same plugin topology", () => {
  const saved = process.env.GSAC_RETRY_BASE_MS;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.GSAC_RETRY_BASE_MS;
    } else {
      process.env.GSAC_RETRY_BASE_MS = saved;
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
    new GitHubApi({ token: "t", io, baseUrl: "https://api.test", apiVersion: DEFAULT_API_VERSION });

  test("many writes complete without the write limiter's ~1s spacing", async () => {
    // Under the real timers, so the knob's millisecond units are what keeps the write limiter's minTime short; the immediate scheduler would
    // pace nothing whatever the units.
    process.env.GSAC_RETRY_BASE_MS = "1";
    stubFetch([() => new Response(null, { status: 204 })]);
    const client = new GitHubApi({
      token: "t",
      io: traceIo().io,
      baseUrl: "https://api.test",
      scheduler: TIMERS_SCHEDULER,
    });
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
    process.env.GSAC_RETRY_BASE_MS = "50";
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
      const client = new GitHubApi({
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
      const client = new GitHubApi({
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

  // The throttle callback alone refuses a wait beyond the cap, but each scheduler runs its own retry loop on that answer (Bottleneck under the
  // timers, ImmediateLimiter under the knob), and the plugin reads a primary limit's wait from x-ratelimit-reset and a secondary limit's
  // (recognized by its phrase) from retry-after. Every pairing must fail at once: neither stalling on an hour-away reset nor retrying blind.
  const primaryResetOverCap = () =>
    new Response('{"message":"rate limited"}', {
      status: 429,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
  const secondaryRetryAfterOverCap = secondaryLimit(String(MAX_RETRY_WAIT_S + 1));
  const timers = () =>
    new GitHubApi({
      token: "t",
      io: traceIo().io,
      baseUrl: "https://api.test",
      retryBaseMs: 1,
      scheduler: TIMERS_SCHEDULER,
    });
  const immediate = () => {
    process.env.GSAC_RETRY_BASE_MS = "1";
    return envKnobClient(traceIo().io);
  };
  test.each([
    ["primary limit's x-ratelimit-reset", "timers", primaryResetOverCap, timers],
    ["primary limit's x-ratelimit-reset", "immediate", primaryResetOverCap, immediate],
    ["secondary limit's retry-after", "timers", secondaryRetryAfterOverCap, timers],
    ["secondary limit's retry-after", "immediate", secondaryRetryAfterOverCap, immediate],
  ])(
    `a 429 whose %s puts the wait beyond the ${MAX_RETRY_WAIT_S}s cap fails now under the %s scheduler`,
    async (_header, _scheduler, response, client) => {
      const state = stubFetch([response, okJson]);
      const result = await client().tryRequest("GET", "/long-wait");
      expect(state.calls).toBe(1);
      expect("error" in result && result.error).toMatchObject({ status: 429, rateLimited: true });
    },
  );
});

describe("response shaping", () => {
  test("204/empty bodies come back as null", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const result = await api().tryRequest("DELETE", "/gone");
    expect("data" in result && result.data).toBeNull();
  });

  test("raw option returns the body text untouched, an empty body as the empty string", async () => {
    stubFetch([() => new Response("repository:\n  has_wiki: false\n")]);
    const options = { accept: "application/vnd.github.raw+json", raw: true };
    const result = await api().tryRequest("GET", "/repos/o/r/contents/x.yml", undefined, options);
    expect("data" in result && result.data).toBe("repository:\n  has_wiki: false\n");
    stubFetch([() => new Response(null, { status: 200 })]);
    const empty = await api().tryRequest(
      "GET",
      "/repos/o/r/contents/empty.yml",
      undefined,
      options,
    );
    expect("data" in empty && empty.data).toBe("");
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

  // x-ratelimit-remaining: 0 alone is ambiguous: a genuine denial on the last quota unit carries it too. The readable message disambiguates, so the
  // zero header must contribute nothing here.
  test.each([
    ["an exhausted primary limit", "API rate limit exceeded for user", true],
    ["a genuine denial", "Resource not accessible by integration", false],
  ])(
    "%s on the token's LAST quota unit classifies through its message, not the zero header",
    async (_name, message, limited) => {
      stubFetch([
        () =>
          new Response(JSON.stringify({ message }), {
            status: 403,
            headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
          }),
      ]);
      const result = await api().tryRequest("GET", "/repos/o/r/labels");
      if (!("error" in result)) {
        throw new Error("expected an error result");
      }
      expect(result.error.rateLimited).toBeUndefined();
      expect(isRateLimitError(result.error)).toBe(limited);
      expect(isPermissionError(result.error)).toBe(!limited);
    },
  );
});

describe("debug-trace hardening for redacted slugs", () => {
  // Every test reads the debug lines its OWN trace facet received, so a concurrent test's output cannot pollute the observation.

  test.each([
    [
      "a slug masked through the Io port is redacted from the trace with no second registration",
      "o/priv",
      ["PATCH <redacted> ->"],
      ["o/priv", "CANARY", "payload:"],
    ],
    [
      "an unregistered slug traces normally, with its payload",
      undefined,
      ["PATCH /repos/o/priv ->", "payload:", "CANARY"],
      ["<redacted>"],
    ],
  ])("%s", async (_name, mask, present, absent) => {
    const dbg = traceIo();
    if (mask !== undefined) {
      dbg.io.mask(mask);
    }
    stubFetch([() => new Response(null, { status: 204 })]);
    await api(dbg.io).tryRequest("PATCH", "/repos/o/priv", { description: "CANARY" });
    const trace = dbg.lines.join("");
    for (const fragment of present) {
      expect(trace).toContain(fragment);
    }
    for (const fragment of absent) {
      expect(trace).not.toContain(fragment);
    }
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

  test("redactingOctokitLog routes every level to the debug channel, masked lines collapsed and unmasked lines intact, never to stderr", () => {
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
        log[level]("GET /repos/o/publicrepo - 200 in 1ms");
      }
      // The gap a path-only redactor misses: the slug outside /repos/ position, as the retry/throttle plugins' free-text prose puts it.
      log.warn("retrying request to e2e-owner/repo-1 after 429");
      log.debug("GET /repos/e2e-owner/repo-1 - 200 with id undefined in 3ms");
    } finally {
      stderrSpy.mockRestore();
    }
    expect(stderrWrites).toBe(0);
    expect(dbg.lines).toEqual([
      ...Array(4).fill(["<redacted>", "GET /repos/o/publicrepo - 200 in 1ms"]).flat(),
      "<redacted>",
      "<redacted>",
    ]);
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

  // Each shape smuggles CANARY past a different field FILTER (spread, for..in); only a rebuild that names its fields drops them all.
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
  // The reason when the scan has no typed rejection to name a field with: a hostile proxy, a bare bigint.
  const NOT_PLAIN_FALLBACK =
    "its payload is not plain JSON data (a value carrying a function or exotic prototype)";

  test.each([
    [
      "config.secret (the hook create shape)",
      "POST",
      "/repos/hookco/hookrepo/hooks",
      {
        name: "web",
        config: { url: "https://example.test/hook", content_type: "json", secret: hostileSecret },
      },
      ['"secret":"***"', '"url":"https://example.test/hook"'],
      ["he said"],
    ],
    [
      "encrypted_value (the actions secret shape)",
      "PUT",
      "/repos/hookco/hookrepo/actions/secrets/DEPLOY_KEY",
      { encrypted_value: "base64-SECRET-material", key_id: "568250167242549743" },
      ['"encrypted_value":"***"', '"key_id":"568250167242549743"'],
      ["base64-SECRET-material"],
    ],
    [
      // PATCH /hooks/{id}/config sends the config object bare, so `secret` sits at the top level.
      "a TOP-LEVEL secret (the hook config sub-endpoint shape)",
      "PATCH",
      "/repos/hookco/hookrepo/hooks/1/config",
      { url: "https://example.test/hook", content_type: "json", secret: hostileSecret },
      ['"secret":"***"', '"url":"https://example.test/hook"'],
      ["he said"],
    ],
    [
      "a secret field at any depth",
      "POST",
      "/repos/hookco/hookrepo/anything",
      { outer: { hooks: [{ config: { secret: hostileSecret } }, { note: "clean" }] } },
      ['"secret":"***"', '"note":"clean"'],
      ["he said"],
    ],
    [
      // A passthrough payload can carry arbitrary user keys, so a `Secret:` spelling must not slip the scan.
      "a re-cased field name (matching is case-insensitive)",
      "POST",
      "/repos/hookco/hookrepo/anything",
      { Secret: hostileSecret, config: { ENCRYPTED_VALUE: hostileSecret } },
      ['"Secret":"***"', '"ENCRYPTED_VALUE":"***"'],
      ["he said"],
    ],
  ])(
    "%s is masked in the trace; the outgoing request is untouched",
    async (_shape, method, path, payload, traced, absent) => {
      // Rendered before the request, so a scan that masked the caller's own payload would show on the wire.
      const wire = JSON.stringify(payload);
      const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
      const dbg = traceIo();
      await api(dbg.io).tryRequest(method, path, payload);
      const trace = dbg.lines.join("");
      for (const fragment of traced) {
        expect(trace).toContain(fragment);
      }
      for (const fragment of absent) {
        expect(trace).not.toContain(fragment);
      }
      expect(sent.bodies).toEqual([wire]);
    },
  );

  test.each([
    [
      "a JSON 422 echoing a config.secret",
      "POST",
      "/repos/hookco/hookrepo/hooks",
      { name: "web", config: { url: "https://example.test/hook", secret: hostileSecret } },
      () =>
        new Response(
          JSON.stringify({
            message: `Validation Failed: secret ${hostileSecret} is too weak`,
            errors: [{ resource: "Hook", field: "secret", value: hostileSecret }],
            documentation_url: "https://docs.github.com/rest/repos/webhooks",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      422,
      '"secret":"***"',
      ["he said", "back", "slash", "too weak", "Hook"],
      false,
    ],
    [
      "a plain-text 400 echoing a TOP-LEVEL secret",
      "PATCH",
      "/repos/hookco/hookrepo/hooks/1/config",
      { url: "https://example.test/hook", content_type: "json", secret: hostileSecret },
      () => new Response(`nope: ${hostileSecret}`, { status: 400 }),
      400,
      '"secret":"***"',
      ["he said", "back", "slash", "nope"],
      false,
    ],
    [
      "a plain-text 400 echoing an encrypted_value",
      "PUT",
      "/repos/hookco/hookrepo/actions/secrets/K",
      { encrypted_value: hostileSecret, key_id: "1" },
      () => new Response(`rejected: ${hostileSecret}`, { status: 400 }),
      400,
      '"encrypted_value":"***"',
      ["he said", "back", "slash", "rejected"],
      false,
    ],
    [
      // The structural signals are read whatever the body's shape: this plaintext body never says "rate limit", so only the retry-after
      // header proves the classification, and it must survive the wholesale replacement.
      "a plain-text 403 with retry-after echoing a TOP-LEVEL secret",
      "PATCH",
      "/repos/hookco/hookrepo/hooks/1/config",
      { url: "https://example.test/hook", content_type: "json", secret: hostileSecret },
      () =>
        new Response(`Forbidden: ${hostileSecret}`, {
          status: 403,
          headers: { "retry-after": "60" },
        }),
      403,
      '"secret":"***"',
      ["he said", "back", "slash", "Forbidden"],
      true,
    ],
  ])(
    "%s is replaced wholesale; only the status and the rate-limit classification survive",
    async (_shape, method, path, payload, response, status, masked, fragments, limited) => {
      const wire = JSON.stringify(payload);
      const sent = stubFetchCapturingBodies(response);
      const dbg = traceIo();
      const result = await api(dbg.io).tryRequest(method, path, payload);
      expect(sent.bodies).toEqual([wire]);
      if (!("error" in result)) {
        throw new Error("expected an error result");
      }
      expect(result.error.status).toBe(status);
      expect(isRateLimitError(result.error)).toBe(limited);
      expect(result.error.documentationUrl).toBeUndefined();
      expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
      expect(result.error.body).toBe(SECRET_RESPONSE_WITHHELD);
      for (const fragment of fragments) {
        expect(result.error.message).not.toContain(fragment);
        expect(result.error.body).not.toContain(fragment);
      }
      const trace = dbg.lines.join("");
      expect(trace).toContain(masked);
      expect(trace).not.toContain("he said");
    },
  );

  test.each([
    [
      "a secret-carrying request withholds the error detail",
      "PATCH",
      "/repos/hookco/hookrepo/hooks/1/config",
      { url: "https://example.test/hook", secret: hostileSecret },
      `request to https://x failed, body was: {"secret":"${hostileSecret}"}`,
      "PATCH /repos/hookco/hookrepo/hooks/1/config failed: the transport failed before an HTTP " +
        "response arrived (details withheld: the request carried a secret field). Check network " +
        "connectivity from the runner to https://api.test, then re-run",
    ],
    [
      "a non-secret request keeps its diagnostic message",
      "GET",
      "/repos/hookco/hookrepo",
      undefined,
      "socket hang up",
      "GET /repos/hookco/hookrepo failed: socket hang up. Check network connectivity from the runner to https://api.test, then re-run",
    ],
  ])("a transport failure on %s", async (_name, method, path, payload, reason, failed) => {
    globalThis.fetch = (async () => {
      throw new Error(reason);
    }) as unknown as typeof fetch;
    const answer = await api().tryRequest(method, path, payload);
    expect(answer).toEqual({ failed });
  });

  test("the caller's mark withholds a payload the field-name scan cannot name; unmarked, the same request reads", async () => {
    // `token` is no scanned field name, so the mark alone decides: the engine sets it from the act of resolving a secret.
    const echo = () =>
      new Response(JSON.stringify({ message: `rejected token ${hostileSecret}` }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    const path = "/repos/hookco/hookrepo/hooks";
    stubFetch([echo]);
    const dbg = traceIo();
    const marked = await api(dbg.io).tryRequest(
      "POST",
      path,
      { token: hostileSecret },
      { carriesSecret: true },
    );
    expect(marked).toEqual({
      error: { status: 422, message: SECRET_RESPONSE_WITHHELD, body: SECRET_RESPONSE_WITHHELD },
    });
    // The trace too: the scan cannot mask a field it does not name, so the whole payload is withheld from the line.
    // The request-log plugin's own "- 422 with id" line shares the prefix; only the arrow line carries the payload.
    expect(dbg.lines.filter((line) => line.includes(" -> "))).toEqual([
      expect.stringMatching(
        /^POST \/repos\/hookco\/hookrepo\/hooks -> 422 \(\d+ms\) payload: <withheld: the request carried a resolved secret>$/,
      ),
    ]);
    expect(dbg.lines.join("\n")).not.toContain("he said");
    stubFetch([echo]);
    const plain = traceIo();
    const unmarked = await api(plain.io).tryRequest("POST", path, { token: hostileSecret });
    expect("error" in unmarked && unmarked.error.message).toBe(`rejected token ${hostileSecret}`);
    expect(plain.lines.join("\n")).toContain('"token":"he said');

    globalThis.fetch = (async () => {
      throw new Error(`request failed, body was: {"token":"${hostileSecret}"}`);
    }) as unknown as typeof fetch;
    expect(
      await api().tryRequest("POST", path, { token: hostileSecret }, { carriesSecret: true }),
    ).toEqual({
      failed: `POST ${path} failed: the transport failed before an HTTP response arrived (details withheld: the request carried a secret field). Check network connectivity from the runner to https://api.test, then re-run`,
    });
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

  // With the message destroyed, the ambiguous x-ratelimit-remaining: 0 is accepted on this path only: the lesser evil against telling a
  // rate-limited user to fix their token.
  test.each([
    [
      "with only the zero-quota header still reads as a rate limit",
      { "x-ratelimit-remaining": "0" },
      true,
    ],
    ["without it stays a permission failure, not a rate limit", {}, false],
  ])("a WITHHELD 403 %s", async (_name, quota, limited) => {
    stubFetch([
      () =>
        new Response(JSON.stringify({ message: `denied (echo: ${hostileSecret})` }), {
          status: 403,
          headers: { "content-type": "application/json", ...quota },
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
    expect(isRateLimitError(result.error)).toBe(limited);
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

  // The hand-rolled normalization never consults toJSON and rejects a function-valued property, so the payload aborts unsent. calls === 0 is
  // the proof: a stringify-based normalization would have invoked toJSON, and this shape hides the secret under no field name at all, where a
  // stringify scan would trace it verbatim.
  test("a toJSON hiding the secret in a renamed container aborts - toJSON is never consulted", async () => {
    let calls = 0;
    const payload = {
      secret: hostileSecret,
      toJSON(): unknown {
        calls++;
        return [hostileSecret];
      },
    };
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = traceIo();
    const answer = await api(dbg.io).tryRequest(
      "PATCH",
      "/repos/hookco/hookrepo/hooks/1/config",
      payload,
    );
    expect(answer).toEqual({
      failed: `PATCH /repos/hookco/hookrepo/hooks/1/config was not sent: the value at "toJSON" is not plain JSON data (a function)${NOT_SENT_TAIL}`,
    });
    expect(calls).toBe(0);
    expect(sent.bodies).toHaveLength(0);
    expect(dbg.lines.join("")).not.toContain("he said");
  });

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
    const answer = await api().tryRequest(
      "PATCH",
      "/repos/hookco/hookrepo/hooks/1/config",
      hostileProxy,
    );
    // The trap's throw is swallowed: no field name, so the fallback reason.
    expect(answer).toEqual({
      failed: `PATCH /repos/hookco/hookrepo/hooks/1/config was not sent: ${NOT_PLAIN_FALLBACK}${NOT_SENT_TAIL}`,
    });
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
    const answer = await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", trapped);
    expect(answer).toEqual({
      failed: `POST /repos/hookco/hookrepo/anything was not sent: the value at "note" is not plain JSON data (an accessor property)${NOT_SENT_TAIL}`,
    });
    expect(getterRan).toBe(false);
    expect(sent.bodies).toHaveLength(0);
  });

  // Only base-class arrays and plain objects are data; the normalizer iterates arrays by index, so a subclass's .map override is foreign code
  // that could substitute [secret]. Octokit passes any other non-plain object (a Buffer) to fetch verbatim, unscanned. Nothing sends such a
  // payload today; the rows pin the boundary with one message.
  class SneakyArray extends Array<unknown> {
    static overrideRan = false;
    override map<U>(_fn: (v: unknown, i: number, a: unknown[]) => U): U[] {
      SneakyArray.overrideRan = true;
      return [hostileSecret] as unknown as U[];
    }
  }
  test.each([
    [
      "an array subclass with an overridden map",
      () => SneakyArray.from([{ name: "web" }]),
      () => SneakyArray.overrideRan,
    ],
    ["a Buffer", () => Buffer.from("raw-bytes-here"), undefined],
  ])("%s is rejected as a non-plain container", async (_kind, payload, foreignCodeRan) => {
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const answer = await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", payload());
    expect(answer).toEqual({
      failed: `POST /repos/hookco/hookrepo/anything was not sent: the value is not plain JSON data (a non-plain object)${NOT_SENT_TAIL}`,
    });
    if (foreignCodeRan !== undefined) {
      expect(foreignCodeRan()).toBe(false);
    }
    expect(sent.bodies).toHaveLength(0);
  });

  test("a YAML !!timestamp value (a Date) reaches the abort with the tag named", async () => {
    // validate.ts already rejects a Date (findNonPlain), so this is the belt under it: the yaml package parses explicit !!timestamp tags to Date
    // objects, and the abort must name the tag.
    const parsed = parseYaml("stamp: !!timestamp 2024-01-01") as Record<string, unknown>;
    expect(parsed.stamp instanceof Date).toBe(true);
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const answer = await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", parsed);
    expect(answer).toEqual({
      failed: `POST /repos/hookco/hookrepo/anything was not sent: the value at "stamp" is not plain JSON data (a Date, e.g. from a YAML !!timestamp tag)${NOT_SENT_TAIL}`,
    });
    expect(sent.bodies).toHaveLength(0);
  });

  test("a top-level bigint payload aborts instead of reaching octokit", async () => {
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const answer = await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", 42n);
    expect(answer).toEqual({
      failed: `POST /repos/hookco/hookrepo/anything was not sent: ${NOT_PLAIN_FALLBACK}${NOT_SENT_TAIL}`,
    });
    expect(sent.bodies).toHaveLength(0);
  });

  test("a cyclic payload aborts at the cycle's field, never a stack overflow or a raw trace", async () => {
    // A YAML alias to an ancestor (config: &c { self: *c }) reaches the scan as a cycle.
    const cyclic: Record<string, unknown> = { url: "https://example.test", secret: hostileSecret };
    cyclic.self = cyclic;
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = traceIo();
    // One descriptor read per container visited: the root, then the cycle is refused before its descriptors are read.
    const visits = spyOn(Object, "getOwnPropertyDescriptors");
    let visited: number;
    let answer: Awaited<ReturnType<GitHubApi["tryRequest"]>>;
    try {
      answer = await api(dbg.io).tryRequest(
        "PATCH",
        "/repos/hookco/hookrepo/hooks/1/config",
        cyclic,
      );
    } finally {
      visited = visits.mock.calls.length; // mockRestore clears the record
      visits.mockRestore();
    }
    expect(answer).toEqual({
      failed: `PATCH /repos/hookco/hookrepo/hooks/1/config was not sent: the value at "self" is not plain JSON data (a reference back to one of its own containers)${NOT_SENT_TAIL}`,
    });
    expect(visited).toBe(1);
    expect(sent.bodies).toHaveLength(0);
    expect(dbg.lines.join("")).not.toContain("he said");
  });

  test("a shared sibling alias is not a cycle: copied twice, scanned, sent", async () => {
    const shared = { note: "same object under two keys" };
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const result = await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", {
      a: shared,
      b: [shared],
    });
    expect("data" in result).toBe(true);
    expect(sent.bodies).toEqual([
      '{"a":{"note":"same object under two keys"},"b":[{"note":"same object under two keys"}]}',
    ]);
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
      const client = new GitHubApi({
        token: "t",
        io: traceIo().io,
        baseUrl: `http://localhost:${server.port}`,
        apiVersion: DEFAULT_API_VERSION,
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
