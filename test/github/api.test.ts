import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { parse as parseYaml } from "yaml";
import {
  GithubApi,
  isPermissionError,
  isRateLimitError,
  redactingOctokitLog,
  registerRedactedSlug,
  SECRET_RESPONSE_WITHHELD,
  unregisterRedactedSlug,
} from "../../src/github/api.js";
import { api, restoreFetch, stubFetch } from "./stub.js";

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
    expect(state.calls).toBe(3); // 1 + MAX_RETRIES
    expect("error" in result && result.error.status).toBe(429);
    expect("error" in result && result.error.message).toContain("rate limited");
  });

  test("a rate-limit reset beyond the 60s cap fails now instead of stalling", async () => {
    // The throttling plugin derives the wait from x-ratelimit-reset for
    // primary limits; an hour-away reset must fail loudly, not stall.
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

describe("throttle plugin honors the test knob", () => {
  const saved = process.env.RETRY_BASE_MS;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.RETRY_BASE_MS;
    } else {
      process.env.RETRY_BASE_MS = saved;
    }
  });

  test("under RETRY_BASE_MS, many writes complete without the write limiter's ~1s spacing", async () => {
    // The throttle plugin's write limiter spaces mutations by ~1000ms in
    // production; under the test knob it must not, so a many-write run stays
    // fast. Construct WITHOUT the retryBaseMs arg so the client reads the env
    // exactly as the spawned bundle does.
    process.env.RETRY_BASE_MS = "1";
    stubFetch([() => new Response(null, { status: 204 })]);
    const client = new GithubApi("t", "https://api.test", "2022-11-28");
    const started = Date.now();
    for (let i = 0; i < 12; i++) {
      await client.tryRequest("PATCH", `/repos/o/r${i}`, { i });
    }
    // 12 production-spaced writes would take ~12s; the knob must keep it well
    // under a second (generous bound to stay non-flaky on a loaded CI box).
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("without the knob the throttle plugin stays enabled (429s are retried)", async () => {
    delete process.env.RETRY_BASE_MS;
    // No env, explicit retryBaseMs=1 arg keeps waits short. A 429 that resolves
    // on retry proves the throttle plugin is active.
    const state = stubFetch([rateLimited, okJson]);
    const client = new GithubApi("t", "https://api.test", "2022-11-28", 1);
    const result = await client.tryRequest("GET", "/rl");
    expect(state.calls).toBe(2);
    expect("data" in result && result.data).toEqual({ ok: true });
  });

  test("UNDER the knob a 429-then-200 recovers on quadratic backoff, ignoring Retry-After", async () => {
    // With the throttle plugin disabled under the knob, the retry plugin takes
    // over 429 (dropped from doNotRetry under the knob) so a transient 429 still
    // RECOVERS. The retry plugin IGNORES the Retry-After header - it backs off
    // (n^2 * retryBaseMs) instead. The 429 here carries a large Retry-After; the
    // fact that recovery is one retry and stays fast (not the header's 30s) is
    // the observable proof the header is not honored on its raw scale, and pins
    // that the retry path is what recovers, not throttle pacing.
    process.env.RETRY_BASE_MS = "1";
    const rateLimitedSlowHeader = () =>
      new Response('{"message":"rate limited"}', {
        status: 429,
        // A large Retry-After: if it were honored on its raw seconds scale the
        // retry would blow past any sane test timeout.
        headers: { "retry-after": "30", "x-ratelimit-remaining": "0" },
      });
    const state = stubFetch([rateLimitedSlowHeader, okJson]);
    const client = new GithubApi("t", "https://api.test", "2022-11-28");
    const started = Date.now();
    const result = await client.tryRequest("GET", "/rl");
    expect(state.calls).toBe(2);
    expect("data" in result && result.data).toEqual({ ok: true });
    // The 30s header did not pace recovery; the quadratic backoff kept it fast.
    expect(Date.now() - started).toBeLessThan(2000);
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
    // errors[] stays appended to the message, as before.
    expect("error" in result && result.error.message).toContain("Invalid rule");
  });

  test("string and empty bodies leave documentationUrl unset", async () => {
    stubFetch([() => new Response("plain text failure", { status: 422 })]);
    const result = await api().tryRequest("POST", "/repos/o/r/rulesets", {});
    expect("error" in result && result.error.documentationUrl).toBeUndefined();
    expect("error" in result && result.error.message).toBe("plain text failure");
  });
});

describe("debug-trace hardening for redacted slugs", () => {
  /**
   * Observe what the client hands to core.debug - the single sink every trace
   * and the octokit `log` route through. Spying the sink directly (rather than
   * intercepting the global process.stdout/stderr streams) keeps the assertion
   * immune to any other test writing concurrently under the parallel runner:
   * we read exactly the messages this client produced, nothing else.
   */
  function captureDebug(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = spyOn(core, "debug").mockImplementation((message?: string) => {
      lines.push(String(message));
    });
    // `lines` is a plain array the mock pushes into, so the recorded messages
    // survive restore() (callers read them after restoring the spy).
    return { lines, restore: () => spy.mockRestore() };
  }

  test("a registered slug's trace collapses the whole path and drops the payload", async () => {
    registerRedactedSlug("o/secretrepo");
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("PATCH", "/repos/o/secretrepo", { description: "CANARY-live" });
    } finally {
      dbg.restore();
      unregisterRedactedSlug("o/secretrepo");
    }
    const trace = dbg.lines.join("");
    // whole path collapses to the constant, no /repos/ prefix, no tail
    expect(trace).toContain("PATCH <redacted> ->");
    expect(trace).not.toContain("o/secretrepo");
    expect(trace).not.toContain("CANARY-live");
    expect(trace).not.toContain("payload:");
  });

  test("a team-repo route redacts its PREFIX too (no team slug leak)", async () => {
    // /orgs/{org}/teams/{team}/repos/{owner}/{repo} - the team slug rides in the
    // prefix before /repos/, so truncating to /repos/<redacted> would leak it.
    // The whole path must collapse to the constant.
    registerRedactedSlug("acme/private");
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("PUT", "/orgs/acme/teams/secret-team/repos/acme/private", {
        permission: "push",
      });
    } finally {
      dbg.restore();
      unregisterRedactedSlug("acme/private");
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain("PUT <redacted> ->");
    expect(trace).not.toContain("secret-team");
    expect(trace).not.toContain("acme/private");
  });

  test("an unregistered slug traces normally, with its payload", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("PATCH", "/repos/o/publicrepo", { description: "open" });
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain("/repos/o/publicrepo");
    expect(trace).toContain("payload:");
  });

  test("unregisterRedactedSlug restores a slug to legible tracing (probe-public undo)", async () => {
    registerRedactedSlug("o/wasprobed");
    unregisterRedactedSlug("o/wasprobed");
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("GET", "/repos/o/wasprobed");
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain("/repos/o/wasprobed");
  });

  test("holds are counted: releasing the probe's hold never clears a permanent one", async () => {
    registerRedactedSlug("o/held-twice"); // probe pre-registration
    registerRedactedSlug("o/held-twice"); // run flow's permanent registration
    unregisterRedactedSlug("o/held-twice"); // probe releases only its own hold
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("GET", "/repos/o/held-twice");
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).not.toContain("o/held-twice");
    expect(trace).toContain("<redacted>");
    unregisterRedactedSlug("o/held-twice");
  });

  test("redactingOctokitLog routes redacted content to core.debug and never to stderr", () => {
    // The exact leak class from the fuzz stderr scan: octokit's plugins log a
    // request line like "GET /repos/owner/repo - 404 ..." (and worse, live-state
    // segments like branch names) to stderr via the default console logger.
    // redactingOctokitLog must collapse any registered slug's line to <redacted>
    // and hand it to core.debug ONLY. Both facts are asserted by spying the two
    // sinks directly - no global stream interception, so a concurrent test's
    // write cannot pollute this observation.
    registerRedactedSlug("e2e-owner/repo-1");
    const debugged: string[] = [];
    let stderrWrites = 0;
    const debugSpy = spyOn(core, "debug").mockImplementation((m?: string) => {
      debugged.push(String(m));
    });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => {
      stderrWrites += 1;
      return true;
    });
    try {
      for (const level of ["debug", "info", "warn", "error"] as const) {
        redactingOctokitLog[level](
          "PUT /repos/e2e-owner/repo-1/branches/dev-secret/protection - 403 in 3ms",
        );
      }
      // The gap a path-only redactor misses: the slug NOT in /repos/ position.
      // Octokit's retry/throttle plugins emit free-text prose like this.
      redactingOctokitLog.warn("retrying request to e2e-owner/repo-1 after 429");
      // And octokit's own request-tracking format, slug followed by prose.
      redactingOctokitLog.debug("GET /repos/e2e-owner/repo-1 - 200 with id undefined in 3ms");
    } finally {
      debugSpy.mockRestore();
      stderrSpy.mockRestore();
      unregisterRedactedSlug("e2e-owner/repo-1");
    }
    // Every routed message went to core.debug, redacted; none of the six calls
    // reached stderr.
    expect(debugged).toHaveLength(6);
    expect(stderrWrites).toBe(0);
    const joined = debugged.join("\n");
    for (const secret of ["e2e-owner/repo-1", "dev-secret", "after 429"]) {
      expect(joined).not.toContain(secret);
    }
    expect(debugged.every((line) => line === "<redacted>")).toBe(true);
  });

  test("redactingOctokitLog leaves an unregistered slug's line intact", () => {
    const dbg = captureDebug();
    try {
      redactingOctokitLog.warn("GET /repos/o/publicrepo - 200 in 1ms");
    } finally {
      dbg.restore();
    }
    expect(dbg.lines.join("")).toContain("/repos/o/publicrepo");
  });

  test("redactingOctokitLog redacts a MIXED-CASE octokit line, slug outside /repos/ position", () => {
    // Octokit logs free-text prose and does not normalize case; the message
    // scan is case-insensitive and position-independent, so a slug written in a
    // different case, and sitting mid-sentence rather than in a /repos/ path,
    // still collapses the whole line.
    registerRedactedSlug("e2e-owner/svc-private");
    const dbg = captureDebug();
    try {
      redactingOctokitLog.warn("retrying E2E-Owner/SVC-Private after 429 (attempt 2)");
      redactingOctokitLog.debug("GET /REPOS/E2E-OWNER/SVC-PRIVATE - 200 with id undefined in 3ms");
    } finally {
      dbg.restore();
      unregisterRedactedSlug("e2e-owner/svc-private");
    }
    const trace = dbg.lines.join("");
    // no casing of the slug survives, and neither does the surrounding prose
    expect(trace.toLowerCase()).not.toContain("svc-private");
    expect(trace).not.toContain("after 429");
    expect(trace).toContain("<redacted>");
  });

  test("during the probe window an octokit line is redacted; after unregister-on-public it is legible", async () => {
    // The probe pre-registers its slug BEFORE the request, so any octokit line
    // emitted while the probe holds the slug is redacted. When the probe
    // resolves PUBLIC it releases its hold, and a later octokit line for the
    // same slug is legible again. The two observable end states are asserted.
    const { createVisibilityResolver } = await import("../../src/github/repo-visibility.js");
    // 1) A slug the probe leaves registered (private) redacts an octokit line.
    stubFetch([
      () => new Response('{"private":true}', { headers: { "content-type": "application/json" } }),
    ]);
    expect(await createVisibilityResolver(api())("owner/still-private")).toBe("private");
    let dbg = captureDebug();
    try {
      redactingOctokitLog.warn("retrying owner/still-private after 429");
    } finally {
      dbg.restore();
    }
    expect(dbg.lines.join("")).toContain("<redacted>");
    expect(dbg.lines.join("")).not.toContain("still-private");
    unregisterRedactedSlug("owner/still-private"); // release the probe's hold

    // 2) A slug the probe resolves PUBLIC is unregistered, so its line is legible.
    stubFetch([
      () => new Response('{"private":false}', { headers: { "content-type": "application/json" } }),
    ]);
    expect(await createVisibilityResolver(api())("owner/went-public")).toBe("public");
    dbg = captureDebug();
    try {
      redactingOctokitLog.warn("GET /repos/owner/went-public - 200 in 1ms");
    } finally {
      dbg.restore();
    }
    expect(dbg.lines.join("")).toContain("owner/went-public");
  });

  test("a rate-limited visibility probe leaks no raw slug in any trace", async () => {
    // Finding A: the probe pre-registers its slug as redacted, so even the
    // throttle-callback trace fired on the 429 retry - which runs before the
    // probe result would otherwise register the slug - must be redacted. The
    // probe resolves private, so the slug stays registered afterward.
    const { createVisibilityResolver } = await import("../../src/github/repo-visibility.js");
    stubFetch([
      rateLimited,
      () => new Response('{"private":true}', { headers: { "content-type": "application/json" } }),
    ]);
    const dbg = captureDebug();
    let visibility: string;
    try {
      visibility = await createVisibilityResolver(api())("secret-owner/secret-repo");
    } finally {
      dbg.restore();
      unregisterRedactedSlug("secret-owner/secret-repo");
    }
    expect(visibility).toBe("private");
    const trace = dbg.lines.join("");
    // neither the direct trace nor the throttle "rate limit on ..." line names it
    expect(trace).not.toContain("secret-owner/secret-repo");
    expect(trace).not.toContain("secret-repo");
    expect(trace).toContain("rate limit on GET <redacted>");
  });
});

describe("secret-field request redaction and fail-closed error responses", () => {
  // Requests here use the hookco/hookrepo slug, not the o/r other suites use:
  // the run-flow tests register o/r with the module-global slug redaction and
  // leave it held, which would collapse these traces in a full-suite run.

  /** Same core.debug spy as the slug-redaction suite: read only this client's lines. */
  function captureDebug(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = spyOn(core, "debug").mockImplementation((message?: string) => {
      lines.push(String(message));
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  /** Fetch stub that also records every outgoing request body. */
  function stubFetchCapturingBodies(response: () => Response): { bodies: string[] } {
    const state = { bodies: [] as string[] };
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      state.bodies.push(String(init?.body ?? ""));
      return response();
    }) as unknown as typeof fetch;
    return state;
  }

  // A value hostile to exact-literal masking: JSON escaping turns the quotes,
  // backslash, and newline into \" \\ \n in the response body, so no literal
  // scan for the original string would find the echo.
  const hostileSecret = 'he said "no" \\ back\nslash';

  test("config.secret is masked in the trace; the outgoing request is untouched", async () => {
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = captureDebug();
    try {
      await api().tryRequest("POST", "/repos/hookco/hookrepo/hooks", {
        name: "web",
        config: { url: "https://example.test/hook", content_type: "json", secret: hostileSecret },
      });
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain('"secret":"***"');
    expect(trace).not.toContain("he said");
    // Non-secret payload fields still trace normally.
    expect(trace).toContain('"url":"https://example.test/hook"');
    // The wire carries the real value; only the trace is masked.
    expect(sent.bodies.join("")).toContain(JSON.stringify(hostileSecret).slice(1, -1));
    expect(sent.bodies.join("")).not.toContain("***");
  });

  test("encrypted_value is masked in the trace", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("PUT", "/repos/hookco/hookrepo/actions/secrets/DEPLOY_KEY", {
        encrypted_value: "base64-SECRET-material",
        key_id: "568250167242549743",
      });
    } finally {
      dbg.restore();
    }
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
    const dbg = captureDebug();
    let result: Awaited<ReturnType<ReturnType<typeof api>["tryRequest"]>>;
    try {
      result = await api().tryRequest("POST", "/repos/hookco/hookrepo/hooks", {
        name: "web",
        config: { url: "https://example.test/hook", secret: hostileSecret },
      });
    } finally {
      dbg.restore();
    }
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.status).toBe(422);
    // Nothing response-derived survives - not even documentation_url.
    expect(result.error.documentationUrl).toBeUndefined();
    // message/errors/body are gone wholesale, not filtered by field name.
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(SECRET_RESPONSE_WITHHELD);
    for (const fragment of ["he said", "back", "slash", "too weak", "Hook"]) {
      expect(result.error.message).not.toContain(fragment);
      expect(result.error.body).not.toContain(fragment);
    }
    // The debug trace never saw the value either.
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
    // PATCH /hooks/{id}/config sends the config object bare, so `secret`
    // sits at the top level - the shape 3C sends on every run with a
    // declared secret.
    const sent = stubFetchCapturingBodies(
      () => new Response(`nope: ${hostileSecret}`, { status: 400 }),
    );
    const dbg = captureDebug();
    let result: Awaited<ReturnType<ReturnType<typeof api>["tryRequest"]>>;
    try {
      result = await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", {
        url: "https://example.test/hook",
        content_type: "json",
        secret: hostileSecret,
      });
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain('"secret":"***"');
    expect(trace).not.toContain("he said");
    expect(sent.bodies.join("")).toContain(JSON.stringify(hostileSecret).slice(1, -1));
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(SECRET_RESPONSE_WITHHELD);
  });

  test("a secret field at any depth is found - the scan is recursive, not shape-listed", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", {
        outer: { hooks: [{ config: { secret: hostileSecret } }, { note: "clean" }] },
      });
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain('"secret":"***"');
    expect(trace).toContain('"note":"clean"');
    expect(trace).not.toContain("he said");
  });

  test("config.encrypted_value nested under config is masked too", async () => {
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("PUT", "/repos/hookco/hookrepo/anything", {
        config: { encrypted_value: "base64-SECRET", key_id: "1" },
      });
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain('"encrypted_value":"***"');
    expect(trace).not.toContain("base64-SECRET");
  });

  test("a transport failure on a secret-carrying request withholds the error detail", async () => {
    // No HTTP response at all; the rejection message quotes request details
    // including the secret, with the quotes/backslash/newline that defeat
    // literal masking.
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
    expect(thrown.message).toContain("details withheld");
    expect(thrown.message).not.toContain("he said");
    expect(thrown.message).not.toContain("body was");
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
    expect(thrown?.message).toContain("socket hang up");
  });

  test("a secret-carrying 403 rate limit still classifies as a rate limit", async () => {
    // isRateLimitError normally reads the message, which the wholesale
    // replacement destroys; the content-free flag must carry the
    // classification so the section gets retry advice, not a permission
    // failure. The flag derives from the plugin-matched signals (headers,
    // the secondary-rate phrase, errors[].type), never from arbitrary
    // body text.
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

  test("an echoed 'rate limit' string cannot spoof the classification", async () => {
    // The classification uses the throttling plugin's exact secondary-limit
    // phrase (\bsecondary rate\b), so a body merely containing "rate limit"
    // (imagine a secret's own text echoing it) with no rate-limit headers
    // stays a permission failure and keeps its grant advice.
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
    // GitHub documents secondary limits where neither x-ratelimit-remaining
    // nor retry-after is present - the message is the only signal. Missing
    // this would misread a rate limit as a permission failure, telling the
    // user to fix their PAT (or silently skipping the section under
    // on-missing-permission: warn).
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

  test("a toJSON collapsing the payload to a primitive aborts instead of leaking", async () => {
    // A plain object whose toJSON returns a string would dodge the
    // field-name scan entirely, print in the trace, and go out as a raw
    // body. Plain data never changes container-ness through a JSON
    // round-trip, so the collapse aborts the request.
    const collapser = {
      note: "clean-looking",
      toJSON(): unknown {
        return `flattened: ${hostileSecret}`;
      },
    };
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = captureDebug();
    let thrown: Error | undefined;
    try {
      await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", collapser);
    } catch (error) {
      thrown = error as Error;
    } finally {
      dbg.restore();
    }
    expect(thrown?.message).toContain("was not sent");
    expect(thrown?.message).not.toContain("he said");
    expect(sent.bodies).toHaveLength(0);
    expect(dbg.lines.join("")).not.toContain("he said");
  });

  test("a toJSON returning null aborts the same way", async () => {
    const nuller = {
      toJSON(): unknown {
        return null;
      },
    };
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    let thrown: Error | undefined;
    try {
      await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", nuller);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("was not sent");
    expect(sent.bodies).toHaveLength(0);
  });

  test("a proxy with a throwing getPrototypeOf trap aborts without leaking its error", async () => {
    // The reflective container check itself can throw on a hostile proxy;
    // that throw must be caught by the fail-closed path, not escape with
    // the trap's message.
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
    expect(thrown?.message).toContain("was not sent");
    expect(thrown?.message).not.toContain("he said");
    expect(sent.bodies).toHaveLength(0);
  });

  test("an accessor property is rejected unread - its getter never runs", async () => {
    // A getter is code, not data: even a getter that would RETURN clean
    // data could sabotage globals as a side effect. Descriptors reject it
    // without invoking it.
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
    expect(thrown?.message).toContain("was not sent");
    expect(getterRan).toBe(false);
    expect(sent.bodies).toHaveLength(0);
  });

  test("an array subclass with an overridden map is rejected, its code never run", async () => {
    // .map on a subclass dispatches to the override - foreign code that
    // could substitute [secret]. Only base-class arrays are plain data,
    // and the normalizer iterates by index rather than dispatching.
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
    expect(thrown?.message).toContain("was not sent");
    expect(overrideRan).toBe(false);
    expect(sent.bodies).toHaveLength(0);
  });

  test("a YAML !!timestamp value (a Date) reaches the abort with the tag named", async () => {
    // Reachable in production: the loose section shapes pass unknown fields
    // through verbatim, and the yaml package parses explicit !!timestamp
    // tags to Date objects. The abort message must point at the YAML tag,
    // not at secret handling.
    const parsed = parseYaml("stamp: !!timestamp 2024-01-01") as Record<string, unknown>;
    expect(parsed.stamp instanceof Date).toBe(true);
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    let thrown: Error | undefined;
    try {
      await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", parsed);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("was not sent");
    expect(thrown?.message).toContain("!!timestamp");
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
    expect(thrown?.message).toContain("was not sent");
    expect(sent.bodies).toHaveLength(0);
  });

  test("a non-plain-object payload (a Buffer) is never sent", async () => {
    // Octokit passes non-plain objects to fetch verbatim; normalizing one
    // would silently change the wire, and sending it unscanned would be a
    // blind spot - so it aborts instead. Nothing sends such a payload
    // today; this pins the boundary.
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
    expect(thrown?.message).toContain("was not sent");
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
    // A throwing accessor is the sharpest case: the getter's error message
    // IS the secret. Normalization resolves accessors inside a try, so the
    // failure aborts the request with a sanitized throw - sending what the
    // scan could not inspect would let a stateful object show the scan one
    // thing and the wire another. The secret appears nowhere.
    const boobyTrapped = {
      url: "https://example.test/hook",
      get secret(): string {
        throw new Error(hostileSecret);
      },
    };
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = captureDebug();
    let thrown: Error | undefined;
    try {
      await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", boobyTrapped);
    } catch (error) {
      thrown = error as Error;
    } finally {
      dbg.restore();
    }
    if (thrown === undefined) {
      throw new Error("expected a thrown abort");
    }
    expect(thrown.message).toContain("was not sent");
    expect(thrown.message).not.toContain("he said");
    expect(sent.bodies).toHaveLength(0);
    expect(dbg.lines.join("")).not.toContain("he said");
  });

  test("a cyclic payload aborts, never a stack overflow or a raw trace", async () => {
    const cyclic: Record<string, unknown> = { url: "https://example.test", secret: hostileSecret };
    cyclic.self = cyclic;
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = captureDebug();
    let thrown: Error | undefined;
    try {
      await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", cyclic);
    } catch (error) {
      thrown = error as Error;
    } finally {
      dbg.restore();
    }
    expect(thrown?.message).toContain("was not sent");
    expect(thrown?.message).not.toContain("he said");
    expect(sent.bodies).toHaveLength(0);
    expect(dbg.lines.join("")).not.toContain("he said");
  });

  test("a STATEFUL toJSON aborts - toJSON is never consulted at all", async () => {
    // First serialization would return a clean object, every later one the
    // secret. The hand-rolled normalization never invokes toJSON and
    // rejects any function-valued property as non-plain data, so the
    // request aborts and the secret never leaves the process in any form.
    let calls = 0;
    const shifty = {
      note: "looks-clean",
      toJSON(): unknown {
        calls++;
        return calls === 1
          ? { note: "looks-clean" }
          : { note: "looks-clean", secret: hostileSecret };
      },
    };
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = captureDebug();
    let thrown: Error | undefined;
    try {
      await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", shifty);
    } catch (error) {
      thrown = error as Error;
    } finally {
      dbg.restore();
    }
    expect(thrown?.message).toContain("was not sent");
    expect(calls).toBe(0);
    expect(sent.bodies).toHaveLength(0);
    expect(dbg.lines.join("")).not.toContain("he said");
  });

  test("a toJSON hiding the secret in a renamed container aborts", async () => {
    // The sharpest shape: toJSON returns a DIFFERENT plain container where
    // the secret sits under no field name at all - a scan of stringify
    // output would find nothing to mask and trace the value verbatim.
    // Never invoking toJSON closes the class.
    const renamer = {
      secret: hostileSecret,
      toJSON(): unknown {
        return [hostileSecret];
      },
    };
    const sent = stubFetchCapturingBodies(() => new Response(null, { status: 204 }));
    const dbg = captureDebug();
    let thrown: Error | undefined;
    try {
      await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", renamer);
    } catch (error) {
      thrown = error as Error;
    } finally {
      dbg.restore();
    }
    expect(thrown?.message).toContain("was not sent");
    expect(thrown?.message).not.toContain("he said");
    expect(sent.bodies).toHaveLength(0);
    expect(dbg.lines.join("")).not.toContain("he said");
  });

  test("field-name matching is case-insensitive", async () => {
    // No GitHub field is anything but lowercase snake_case, but a passthrough
    // payload can carry arbitrary user keys; a `Secret:` spelling must not
    // slip the scan.
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest("POST", "/repos/hookco/hookrepo/anything", {
        Secret: hostileSecret,
        config: { ENCRYPTED_VALUE: hostileSecret },
      });
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("");
    expect(trace).toContain('"Secret":"***"');
    expect(trace).toContain('"ENCRYPTED_VALUE":"***"');
    expect(trace).not.toContain("he said");
  });

  test("an own __proto__ key survives in the trace instead of vanishing", async () => {
    // JSON.parse creates __proto__ as an own DATA property; the masked copy
    // must keep the branch (a plain {} target would hit the prototype
    // setter and drop it, breaking trace fidelity).
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    try {
      await api().tryRequest(
        "POST",
        "/repos/hookco/hookrepo/anything",
        JSON.parse(`{"__proto__": {"note": "kept"}, "config": {"secret": "s3cret-here"}}`),
      );
    } finally {
      dbg.restore();
    }
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

  test("a toJSON smuggling a secret field aborts - functions are not plain data", async () => {
    // The field exists only in toJSON's output; a stringify-based
    // normalization would have to mask it after the fact. Never invoking
    // toJSON and rejecting function-valued properties aborts instead.
    const sneaky = {
      note: "clean-looking",
      toJSON(): unknown {
        return { note: "clean-looking", secret: hostileSecret };
      },
    };
    stubFetch([() => new Response(null, { status: 204 })]);
    const dbg = captureDebug();
    let thrown: Error | undefined;
    try {
      await api().tryRequest("PATCH", "/repos/hookco/hookrepo/hooks/1/config", sneaky);
    } catch (error) {
      thrown = error as Error;
    } finally {
      dbg.restore();
    }
    expect(thrown?.message).toContain("was not sent");
    expect(dbg.lines.join("")).not.toContain("he said");
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
    // Includes a config object WITHOUT secret fields: presence of `config`
    // alone must not trigger anything.
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
    const dbg = captureDebug();
    let result: Awaited<ReturnType<ReturnType<typeof api>["tryRequest"]>>;
    try {
      result = await api().tryRequest("POST", "/repos/hookco/hookrepo/hooks", payload);
    } finally {
      dbg.restore();
    }
    // The traced payload is the original object, byte-identical JSON.
    expect(dbg.lines.join("")).toContain(` payload: ${JSON.stringify(payload)}`);
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    // The error keeps the message/errors/body shaping exactly as before.
    expect(result.error.message).toBe(
      'Validation Failed ([{"field":"name","message":"bad name"}])',
    );
    expect(result.error.body).toContain('"bad name"');
    expect(result.error.documentationUrl).toBe("https://docs.github.com/rest");
  });
});
