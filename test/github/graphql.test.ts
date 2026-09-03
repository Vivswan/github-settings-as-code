/**
 * The GraphQL transport: tryGraphql's errors[]-inside-200 mapping (the
 * load-bearing difference from REST), its trace redaction (the slug rides in
 * the BODY, invisible to URL-based redaction), and its reuse of the shared
 * HTTP-level error classification.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import type { GraphqlOp } from "../../src/github/api.js";
import {
  GithubApi,
  isPermissionError,
  isRateLimitError,
  REDACTED_RESPONSE_WITHHELD,
  registerRedactedSlug,
  SECRET_RESPONSE_WITHHELD,
  unregisterRedactedSlug,
} from "../../src/github/api.js";
import { api, restoreFetch, stubFetch } from "./stub.js";

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

/** The core.debug capture from api.test.ts, for the trace assertions. */
function captureDebug(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(core, "debug").mockImplementation((message?: string) => {
    lines.push(String(message));
  });
  return { lines, restore: () => spy.mockRestore() };
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

  test("a 200 with neither data nor errors throws the wire-contract error", async () => {
    stubFetch([() => graphql({ ok: true })]);
    await expect(api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r")).rejects.toThrow(
      /GRAPHQL RepoToggles returned a response carrying neither errors nor a data object/,
    );
  });
});

describe("tryGraphql errors[] mapping", () => {
  const errorResponse = (type: string, message: string) =>
    graphql({ data: null, errors: [{ type, path: ["repository"], message }] });

  test("NOT_FOUND maps to a 404 permission-classifiable error carrying its observed type", async () => {
    stubFetch([() => errorResponse("NOT_FOUND", "Could not resolve to a Repository")]);
    const result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.status).toBe(404);
    expect(result.error.message).toContain("Could not resolve");
    expect(result.error.graphqlTypes).toEqual(["NOT_FOUND"]);
    expect(isPermissionError(result.error)).toBe(true);
  });

  test("FORBIDDEN and INSUFFICIENT_SCOPES map to 403", async () => {
    for (const type of ["FORBIDDEN", "INSUFFICIENT_SCOPES"]) {
      stubFetch([() => errorResponse(type, "nope")]);
      const result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
      expect("error" in result && result.error.status).toBe(403);
      expect("error" in result && isPermissionError(result.error)).toBe(true);
    }
  });

  test("RATE_LIMITED maps to 403 with the content-free rateLimited flag", async () => {
    stubFetch([() => errorResponse("RATE_LIMITED", "API rate limit exceeded")]);
    const result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.status).toBe(403);
    expect(result.error.rateLimited).toBe(true);
    expect(isRateLimitError(result.error)).toBe(true);
    expect(isPermissionError(result.error)).toBe(false);
  });

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
    expect(result.error.body).toContain("UNPROCESSABLE");
    // A partially-typed response carries NO graphqlTypes: the untyped entry
    // must make the whole response untolerable, not hide behind its typed
    // sibling.
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

  test("a malformed errors value fails closed even beside valid-looking data", async () => {
    // {data, errors: {...}} must never read as "no errors": treating the
    // malformed errors as absent would turn a partial response into success.
    // With the throttling plugin enabled, ITS graphql inspection trips over
    // the non-array first and the transport catch fails closed; under the
    // RETRY_BASE_MS knob (the e2e configuration) the plugin is off and OUR
    // guard must carry the invariant alone - both paths are pinned.
    stubFetch([
      () => graphql({ data: { repository: { id: "R_1" } }, errors: { type: "NOT_FOUND" } }),
    ]);
    await expect(api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r")).rejects.toThrow(
      /GRAPHQL RepoToggles/,
    );
    process.env.RETRY_BASE_MS = "1";
    try {
      const knobApi = new GithubApi("t", "https://api.test", "2022-11-28");
      stubFetch([
        () => graphql({ data: { repository: { id: "R_1" } }, errors: { type: "NOT_FOUND" } }),
      ]);
      await expect(knobApi.tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r")).rejects.toThrow(
        /GRAPHQL RepoToggles returned a malformed errors value/,
      );
    } finally {
      delete process.env.RETRY_BASE_MS;
    }
  });

  test("an empty errors array fails closed (present means non-empty)", async () => {
    stubFetch([() => graphql({ data: { repository: { id: "R_1" } }, errors: [] })]);
    await expect(api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r")).rejects.toThrow(
      /GRAPHQL RepoToggles returned a malformed errors value/,
    );
  });

  // Rate limit wins over BOTH lower priorities: beside FORBIDDEN it must not
  // read as a permission failure (the user would be told to fix their PAT),
  // and beside UNPROCESSABLE it must not read as a bad payload.
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
    // GraphQL can answer half the query; a section acting on the half would
    // mis-diff, so ANY non-empty errors[] is an error result.
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
    const dbg = captureDebug();
    try {
      await api().tryGraphql(READ_OP, { owner: "o", repo: "publicrepo" }, "o/publicrepo");
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("\n");
    expect(trace).toContain("GRAPHQL RepoToggles -> 200");
    expect(trace).toContain('variables: {"owner":"o","repo":"publicrepo"}');
  });

  test("a registered slug collapses the WHOLE line (variables carry live state)", async () => {
    registerRedactedSlug("o/secretrepo");
    stubFetch([() => graphql({ data: {} })]);
    const dbg = captureDebug();
    try {
      await api().tryGraphql(
        READ_OP,
        { owner: "o", repo: "secretrepo", pattern: "CANARY-live" },
        "o/secretrepo",
      );
    } finally {
      dbg.restore();
      unregisterRedactedSlug("o/secretrepo");
    }
    const trace = dbg.lines.join("\n");
    expect(trace).toContain("<redacted>");
    expect(trace).not.toContain("RepoToggles");
    expect(trace).not.toContain("secretrepo");
    expect(trace).not.toContain("CANARY-live");
  });

  test("a registered slug inside the rendered line fails closed even when the slug param differs", async () => {
    // The redactMessage backstop: the op addresses one repo but a DIFFERENT
    // registered slug appears in the variables (a cross-repo value). The
    // whole-line scan must still collapse it.
    registerRedactedSlug("acme/private");
    stubFetch([() => graphql({ data: {} })]);
    const dbg = captureDebug();
    try {
      await api().tryGraphql(READ_OP, { owner: "o", repo: "r", source: "acme/private" }, "o/r");
    } finally {
      dbg.restore();
      unregisterRedactedSlug("acme/private");
    }
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
    const dbg = captureDebug();
    let result: Awaited<ReturnType<ReturnType<typeof api>["tryGraphql"]>>;
    try {
      result = await api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r");
    } finally {
      dbg.restore();
    }
    expect("data" in result).toBe(true);
    expect(dbg.lines.join("\n")).toContain("warnings:");
    expect(dbg.lines.join("\n")).toContain("legacy node id");
  });

  test("a registered slug's error content is withheld, keeping the structural fields", async () => {
    // GraphQL error messages quote the slug verbatim ("Could not resolve to a
    // Repository with the name 'o/secretrepo'"), so a redacted repository's
    // error body is replaced wholesale; the classification fields survive.
    registerRedactedSlug("o/secretrepo");
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
    let result: Awaited<ReturnType<ReturnType<typeof api>["tryGraphql"]>>;
    try {
      result = await api().tryGraphql(READ_OP, { owner: "o", repo: "secretrepo" }, "o/secretrepo");
    } finally {
      unregisterRedactedSlug("o/secretrepo");
    }
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(REDACTED_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(REDACTED_RESPONSE_WITHHELD);
    expect(result.error.status).toBe(404);
    expect(result.error.graphqlTypes).toEqual(["NOT_FOUND"]);
  });

  test("a redacted HTTP-level rate limit keeps its structural classification, nothing else", async () => {
    // The withholding must not destroy rate-limit classification: with the
    // message gone, only the structurally computed flag can distinguish a
    // 403 rate limit from a permission denial. The docs URL is rebuilt away
    // with everything else outside the whitelist.
    registerRedactedSlug("o/secretrepo");
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
    let result: Awaited<ReturnType<ReturnType<typeof api>["tryGraphql"]>>;
    try {
      result = await api().tryGraphql(READ_OP, { owner: "o", repo: "secretrepo" }, "o/secretrepo");
    } finally {
      unregisterRedactedSlug("o/secretrepo");
    }
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.rateLimited).toBe(true);
    expect(isRateLimitError(result.error)).toBe(true);
    expect(result.error.message).toBe(REDACTED_RESPONSE_WITHHELD);
    expect(result.error.documentationUrl).toBeUndefined();
  });

  test("a redacted slug's transport failure withholds the reason too", async () => {
    registerRedactedSlug("o/secretrepo");
    globalThis.fetch = (async () => {
      throw new Error("socket hang up talking to o/secretrepo");
    }) as unknown as typeof fetch;
    try {
      await expect(
        api().tryGraphql(READ_OP, { owner: "o", repo: "secretrepo" }, "o/secretrepo"),
      ).rejects.toThrow(/details withheld: the repository is redacted/);
    } finally {
      unregisterRedactedSlug("o/secretrepo");
    }
  });

  test("a secret-named variable is masked in the trace and its error body withheld", async () => {
    stubFetch([
      () => graphql({ data: null, errors: [{ type: "UNPROCESSABLE", message: "echo: hunter2" }] }),
    ]);
    const dbg = captureDebug();
    let result: Awaited<ReturnType<ReturnType<typeof api>["tryGraphql"]>>;
    try {
      result = await api().tryGraphql(WRITE_OP, { id: "X", secret: "hunter2" }, "o/r");
    } finally {
      dbg.restore();
    }
    expect(dbg.lines.join("\n")).not.toContain("hunter2");
    if (!("error" in result)) {
      throw new Error("expected an error result");
    }
    expect(result.error.message).toBe(SECRET_RESPONSE_WITHHELD);
    expect(result.error.body).toBe(SECRET_RESPONSE_WITHHELD);
  });

  test("warnings on a secret-carrying request keep only their count", async () => {
    stubFetch([
      () =>
        graphql({
          data: { ok: true },
          extensions: { warnings: [{ type: "DEPRECATION", message: "echo: hunter2" }] },
        }),
    ]);
    const dbg = captureDebug();
    try {
      await api().tryGraphql(WRITE_OP, { id: "X", secret: "hunter2" }, "o/r");
    } finally {
      dbg.restore();
    }
    const trace = dbg.lines.join("\n");
    expect(trace).toContain("warnings: 1 (details withheld");
    expect(trace).not.toContain("hunter2");
  });

  test("a network-level failure throws with the GRAPHQL label and rerun advice", async () => {
    globalThis.fetch = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(api().tryGraphql(READ_OP, { owner: "o", repo: "r" }, "o/r")).rejects.toThrow(
      /GRAPHQL RepoToggles failed: socket hang up\. Check network connectivity/,
    );
  });
});
