/**
 * tryGraphql's load-bearing differences from REST: errors[] inside a 200, and the slug riding in the BODY, invisible to URL-based redaction.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { GraphqlOp } from "../../src/github/api.js";
import {
  DEFAULT_API_VERSION,
  GitHubApi,
  isPermissionError,
  isRateLimitError,
  REDACTED_RESPONSE_WITHHELD,
  SECRET_RESPONSE_WITHHELD,
} from "../../src/github/api.js";
import { IMMEDIATE_SCHEDULER, TIMERS_SCHEDULER } from "../../src/github/scheduler.js";
import { api, restoreFetch, stubFetch, traceIo } from "./stub.js";

afterEach(restoreFetch);

const READ_OP: GraphqlOp = {
  name: "RepoToggles",
  kind: "read",
  query:
    "query RepoToggles($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }",
};

const WRITE_OP: GraphqlOp = {
  name: "UpdateToggles",
  kind: "write",
  query:
    "mutation UpdateToggles($id: ID!) { updateRepository(input: {repositoryId: $id}) { clientMutationId } }",
};

/** A 200 GraphQL envelope response. */
function graphql(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("tryGraphql success and envelope", () => {
  test("a 200 with a data object resolves to that object", async () => {
    stubFetch([() => graphql({ data: { repository: { id: "R_1" } } })]);
    const result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    expect("data" in result && result.data).toEqual({ repository: { id: "R_1" } });
  });

  test("the request carries query, operationName, and variables", async () => {
    let sent: Record<string, unknown> | undefined;
    stubFetch([() => graphql({ data: {} })]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return realFetch(input, init);
    }) as unknown as typeof fetch;
    await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    expect(sent).toEqual({
      query: READ_OP.query,
      operationName: "RepoToggles",
      variables: { owner: "o", repo: "r" },
    });
  });

  test("a 200 with neither data nor errors fails with the wire-contract line", async () => {
    stubFetch([() => graphql({ ok: true })]);
    expect(await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r")).toEqual({
      failed: expect.stringMatching(
        /GRAPHQL RepoToggles returned a response carrying neither errors nor a data object/,
      ),
    });
  });
});

describe("tryGraphql errors[] mapping", () => {
  const errorResponse = (type: string, message: string) =>
    graphql({ data: null, errors: [{ type, path: ["repository"], message }] });

  const typeRows: Array<[type: string, status: number, rateLimited: true | undefined]> = [
    ["NOT_FOUND", 404, undefined],
    ["FORBIDDEN", 403, undefined],
    ["INSUFFICIENT_SCOPES", 403, undefined],
    ["RATE_LIMITED", 403, true],
  ];
  test.each(typeRows)(
    "errors[].type %s maps to a %d error carrying its observed type",
    async (type, status, rateLimited) => {
      stubFetch([() => errorResponse(type, "Could not resolve to a Repository")]);
      const result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
      if (!("error" in result)) {
        throw new Error("expected an error result");
      }
      expect(result.error.status).toBe(status);
      expect(result.error.message).toBe("Could not resolve to a Repository");
      expect(result.error.graphqlTypes).toEqual([type]);
      expect(result.error.rateLimited).toBe(rateLimited);
      expect(isRateLimitError(result.error)).toBe(rateLimited === true);
      expect(isPermissionError(result.error)).toBe(rateLimited !== true);
    },
  );

  test("an unknown (or missing) type maps to 422 with joined messages", async () => {
    stubFetch([
      () =>
        graphql({
          data: null,
          errors: [
            { type: "UNPROCESSABLE", message: "first problem" },
            { message: "second problem" },
          ],
        }),
    ]);
    const result = await api().tryGraphql(WRITE_OP, { id: "X" }, "o/r");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.status).toBe(422);
    expect(result.error.message).toBe("first problem; second problem");
    // The body is the errors[] array alone, never the whole envelope.
    expect(result.error.body).toBe(
      '[{"type":"UNPROCESSABLE","message":"first problem"},{"message":"second problem"}]',
    );
    // A partially-typed response carries NO graphqlTypes: the untyped entry must make the whole response untolerable.
    expect(result.error.graphqlTypes).toBeUndefined();
  });

  test("mixed observed types are all preserved, deduped and sorted", async () => {
    stubFetch([
      () =>
        graphql({
          data: null,
          errors: [
            { type: "UNPROCESSABLE", message: "also broken" },
            { type: "FORBIDDEN", message: "denied" },
            { type: "FORBIDDEN", message: "denied again" },
          ],
        }),
    ]);
    const result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.status).toBe(403);
    expect(result.error.graphqlTypes).toEqual(["FORBIDDEN", "UNPROCESSABLE"]);
  });

  // {data, errors: null} and {data, errors: []} must never read as "no errors": the contract makes errors, when present, a non-empty list. (An
  // errors OBJECT trips the throttling plugin's own inspection first and never reaches this guard.)
  test.each([
    ["null", null],
    ["an empty array", []],
  ])(
    "a malformed errors value (%s) fails closed even beside valid-looking data",
    async (_shape, errors) => {
      stubFetch([() => graphql({ data: { repository: { id: "R_1" } }, errors })]);
      expect(await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r")).toEqual({
        failed: expect.stringMatching(/GRAPHQL RepoToggles returned a malformed errors value/),
      });
    },
  );

  // The ladder reads the rate limit first: beside FORBIDDEN it must not read as a permission failure (the user would be told to fix their PAT),
  // beside UNPROCESSABLE not as a bad payload.
  test.each([
    ["a permission error (FORBIDDEN)", { type: "FORBIDDEN", message: "denied" }],
    ["a payload error (UNPROCESSABLE)", { type: "UNPROCESSABLE", message: "also broken" }],
  ])("RATE_LIMITED mixed with %s still classifies as a rate limit", async (_name, sibling) => {
    stubFetch([
      () =>
        graphql({
          data: null,
          errors: [sibling, { type: "RATE_LIMITED", message: "slow down" }],
        }),
    ]);
    const result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.status).toBe(403);
    expect(result.error.rateLimited).toBe(true);
    expect(isRateLimitError(result.error)).toBe(true);
    expect(isPermissionError(result.error)).toBe(false);
  });

  test("partial data beside errors still fails closed", async () => {
    // GraphQL can answer half the query; a section acting on the half would mis-diff, so ANY non-empty errors[] is an error result.
    stubFetch([
      () =>
        graphql({
          data: { repository: { id: "R_1" } },
          errors: [{ type: "FORBIDDEN", message: "field denied" }],
        }),
    ]);
    const result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    expect("error" in result && result.error.status).toBe(403);
  });

  test("HTTP-level failures ride the shared classification (401 stays 401)", async () => {
    stubFetch([
      () =>
        new Response('{"message":"Bad credentials"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ]);
    const result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    expect("error" in result && result.error.status).toBe(401);
    expect("error" in result && result.error.message).toBe("Bad credentials");
  });
});

describe("tryGraphql tracing and redaction", () => {
  test("the trace names the operation and its variables", async () => {
    stubFetch([() => graphql({ data: {} })]);
    const dbg = traceIo();
    await api(dbg.io).tryGraphql(READ_OP, { owner: "o", repo: "publicrepo" }, "o/publicrepo");
    const trace = dbg.lines.join("\n");
    expect(trace).toContain("GRAPHQL RepoToggles -> 200");
    expect(trace).toContain('variables: {"owner":"o","repo":"publicrepo"}');
  });

  test("a masked slug collapses the WHOLE line (variables carry live state)", async () => {
    const dbg = traceIo();
    dbg.io.mask("o/secretrepo");
    stubFetch([() => graphql({ data: {} })]);
    await api(dbg.io).tryGraphql(
      READ_OP,
      { owner: "o", repo: "secretrepo", pattern: "CANARY-live" },
      "o/secretrepo",
    );
    // The client's line is the constant alone; the other lines are octokit's own timed chatter, so they are not pinned.
    expect(dbg.lines).toContain("<redacted>");
    const trace = dbg.lines.join("\n");
    expect(trace).not.toContain("RepoToggles");
    expect(trace).not.toContain("secretrepo");
    expect(trace).not.toContain("CANARY-live");
  });

  test("a masked slug inside the rendered line fails closed even when the slug param differs", async () => {
    const dbg = traceIo();
    dbg.io.mask("acme/private");
    stubFetch([() => graphql({ data: {} })]);
    await api(dbg.io).tryGraphql(READ_OP, { owner: "o", repo: "r", source: "acme/private" }, "o/r");
    const trace = dbg.lines.join("\n");
    expect(trace).not.toContain("acme/private");
  });

  test("extensions.warnings surface through the trace, never as errors", async () => {
    stubFetch([
      () =>
        graphql({
          data: { repository: { id: "R_1" } },
          extensions: { warnings: [{ type: "DEPRECATION", message: "legacy node id" }] },
        }),
    ]);
    const dbg = traceIo();
    const result = await api(dbg.io).tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    expect(result).toEqual({ data: { repository: { id: "R_1" } } });
    expect(dbg.lines.join("\n")).toContain("warnings:");
    expect(dbg.lines.join("\n")).toContain("legacy node id");
  });

  test("a masked slug's error content is withheld, keeping the structural fields", async () => {
    // GraphQL error messages quote the slug verbatim ("Could not resolve to a Repository with the name 'o/secretrepo'"), so the error body is
    // replaced wholesale.
    const dbg = traceIo();
    dbg.io.mask("o/secretrepo");
    stubFetch([
      () =>
        graphql({
          data: null,
          errors: [
            {
              type: "NOT_FOUND",
              message: "Could not resolve to a Repository with the name 'o/secretrepo'",
            },
          ],
        }),
    ]);
    const result = await api(dbg.io).tryGraphql(
      READ_OP,
      { owner: "o", repo: "secretrepo" },
      "o/secretrepo",
    );
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(REDACTED_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(REDACTED_RESPONSE_WITHHELD);
    expect(result.error.status).toBe(404);
    expect(result.error.graphqlTypes).toEqual(["NOT_FOUND"]);
  });

  test("a redacted HTTP-level rate limit keeps its structural classification, nothing else", async () => {
    // With the message gone, only the structurally computed flag can distinguish a 403 rate limit from a permission denial.
    const dbg = traceIo();
    dbg.io.mask("o/secretrepo");
    stubFetch([
      () =>
        new Response(
          JSON.stringify({
            message: "API rate limit exceeded for o/secretrepo",
            documentation_url: "https://docs.github.com/rest/rate-limit",
          }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining": "0",
            },
          },
        ),
    ]);
    const result = await api(dbg.io).tryGraphql(
      READ_OP,
      { owner: "o", repo: "secretrepo" },
      "o/secretrepo",
    );
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.rateLimited).toBe(true);
    expect(isRateLimitError(result.error)).toBe(true);
    expect(result.error.message).toBe(REDACTED_RESPONSE_WITHHELD);
    expect(result.error.documentationUrl).toBeUndefined();
  });

  test("a mask registered while the request is in flight redacts the trace and withholds the errors[] content", async () => {
    // Redaction is read at emission, never snapshotted at request start: the stub masks the slug after the request went out.
    const t = traceIo();
    stubFetch([
      () => {
        t.io.mask("o/secretrepo");
        return graphql({
          data: null,
          errors: [{ type: "NOT_FOUND", message: "no repository named 'o/secretrepo'" }],
        });
      },
    ]);
    const result = await api(t.io).tryGraphql(
      READ_OP,
      { owner: "o", repo: "secretrepo", pattern: "CANARY-live" },
      "o/secretrepo",
    );
    expect(t.lines).toContain("<redacted>");
    const trace = t.lines.join("\n");
    expect(trace).not.toContain("secretrepo");
    expect(trace).not.toContain("CANARY-live");
    expect(trace).not.toContain("RepoToggles");
    expect("error" in result ? result.error.message : undefined).toBe(REDACTED_RESPONSE_WITHHELD);
    expect(JSON.stringify(result)).not.toContain("secretrepo");
  });

  test("a mask registered while the request is in flight withholds the transport-failure reason", async () => {
    const t = traceIo();
    const rawReason = "socket hang up talking to o/secretrepo";
    globalThis.fetch = (async () => {
      t.io.mask("o/secretrepo");
      throw new Error(rawReason);
    }) as unknown as typeof fetch;
    expect(
      await api(t.io).tryGraphql(READ_OP, { owner: "o", repo: "secretrepo" }, "o/secretrepo"),
    ).toEqual({
      failed:
        "GRAPHQL RepoToggles failed: the transport failed before an HTTP response arrived (details withheld: the repository is redacted). Check network connectivity from the runner to https://api.test, then re-run",
    });
  });

  test("a secret-named variable is masked in the trace and its error body withheld", async () => {
    stubFetch([
      () => graphql({ data: null, errors: [{ type: "UNPROCESSABLE", message: "echo: hunter2" }] }),
    ]);
    const dbg = traceIo();
    const result = await api(dbg.io).tryGraphql(WRITE_OP, { id: "X", secret: "hunter2" }, "o/r");
    expect(dbg.lines.join("\n")).not.toContain("hunter2");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(SECRET_RESPONSE_WITHHELD);
  });

  test("the caller's mark withholds an error body whose variables name no scanned field", async () => {
    const echo = () =>
      graphql({ data: null, errors: [{ type: "UNPROCESSABLE", message: "echo: hunter2" }] });
    stubFetch([echo]);
    const dbg = traceIo();
    const marked = await api(dbg.io).tryGraphql(WRITE_OP, { id: "X", token: "hunter2" }, "o/r", {
      carriesSecret: true,
    });
    expect(dbg.lines.filter((line) => line.startsWith("GRAPHQL "))).toEqual([
      expect.stringMatching(
        /^GRAPHQL UpdateToggles -> 200 \(\d+ms\) variables: <withheld: the request carried a resolved secret>$/,
      ),
    ]);
    expect(dbg.lines.join("\n")).not.toContain("hunter2");
    expect(marked).toEqual({
      error: {
        status: 422,
        message: SECRET_RESPONSE_WITHHELD,
        body: SECRET_RESPONSE_WITHHELD,
        graphqlTypes: ["UNPROCESSABLE"],
      },
    });
    stubFetch([echo]);
    const unmarked = await api().tryGraphql(WRITE_OP, { id: "X", token: "hunter2" }, "o/r");
    expect("error" in unmarked && unmarked.error.message).toBe("echo: hunter2");
  });

  test("warnings on a secret-carrying request keep only their count", async () => {
    stubFetch([
      () =>
        graphql({
          data: { ok: true },
          extensions: { warnings: [{ type: "DEPRECATION", message: "echo: hunter2" }] },
        }),
    ]);
    const dbg = traceIo();
    await api(dbg.io).tryGraphql(WRITE_OP, { id: "X", secret: "hunter2" }, "o/r");
    const trace = dbg.lines.join("\n");
    expect(trace).toContain("warnings: 1 (details withheld");
    expect(trace).not.toContain("hunter2");
  });

  test.each([
    ["timers", TIMERS_SCHEDULER],
    ["immediate", IMMEDIATE_SCHEDULER],
  ])(
    "a network-level failure fails with the GRAPHQL label and rerun advice (%s scheduler)",
    async (_label, scheduler) => {
      // The throttling plugin inspects every failed /graphql request and reads `error.response.headers`, which a transport error lacks; the
      // original error must survive that handler under both schedulers.
      globalThis.fetch = (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch;
      const client = new GitHubApi({
        token: "t",
        io: traceIo().io,
        baseUrl: "https://api.test",
        apiVersion: DEFAULT_API_VERSION,
        retryBaseMs: 1,
        scheduler,
      });
      expect(await client.tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r")).toEqual({
        failed: expect.stringMatching(
          /GRAPHQL RepoToggles failed: socket hang up\. Check network connectivity/,
        ),
      });
    },
  );
});
