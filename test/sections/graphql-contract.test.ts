/**
 * The GraphQL request helpers and their error classification: callGraphql's
 * throwFor routing (with `GRAPHQL <opName>` in the method/path slot),
 * tryCallGraphql's observed-type tolerance, listGraphqlConnection's cursor
 * loop over its declared connection, and overrideAdviceLevel's awareness of
 * GraphQL writes.
 */

import { describe, expect, test } from "bun:test";
import {
  callGraphql,
  type GraphqlOpDecl,
  type GraphqlPaginatedReadDecl,
  grantFor,
  graphqlOp,
  listGraphqlConnection,
  overrideAdviceLevel,
  PermissionDenied,
  type SectionContext,
  type SectionMeta,
  sectionGrant,
  toleratedGraphqlErrors,
  tryCallGraphql,
} from "../../src/sections/contract.js";
import { MockApi } from "../mock-api.js";

const section: SectionMeta = {
  key: "repository",
  permission: { repo: ["administration"] },
  endpoints: {},
  undeclaredDefault: "untouched",
};

const READ_OP = graphqlOp<{ owner: string; repo: string }>()({
  name: "RepoToggles",
  kind: "read",
  query:
    "query RepoToggles($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }",
  outcomes: { ok: "the repository's toggle states" },
});

function ctx(api: MockApi): SectionContext {
  return {
    api,
    repo: { owner: "o", name: "r", slug: "o/r" },
    check: false,
    resolveSecret: (reference: string): string => {
      throw new Error(`test resolver has no value for ${reference}`);
    },
  };
}

describe("callGraphql", () => {
  test("returns the data object on success", async () => {
    const api = new MockApi({
      "GRAPHQL RepoToggles": { data: { repository: { id: "R_1" } } },
    });
    const data = await callGraphql(ctx(api), section, READ_OP, { owner: "o", repo: "r" });
    expect(data).toEqual({ repository: { id: "R_1" } });
    expect(api.calls).toEqual([
      {
        method: "GRAPHQL",
        path: "RepoToggles",
        payload: { owner: "o", repo: "r" },
        graphqlKind: "read",
      },
    ]);
  });

  test("a permission error classifies as PermissionDenied with GRAPHQL rendering", async () => {
    const api = new MockApi({
      "GRAPHQL RepoToggles": {
        error: { status: 403, message: "Resource not accessible", body: "" },
      },
    });
    let thrown: unknown;
    try {
      await callGraphql(
        ctx(api),
        section,
        READ_OP,
        { owner: "o", repo: "r" },
        { describe: "reading repository toggles" },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    const denied = thrown as PermissionDenied;
    expect(denied.detail).toContain("reading repository toggles failed - GRAPHQL RepoToggles: 403");
    expect(denied.detail).toContain(sectionGrant(section));
  });

  test("a 422 takes the generic rejection branch, naming the operation", async () => {
    const api = new MockApi({
      "GRAPHQL RepoToggles": { error: { status: 422, message: "bad value", body: "" } },
    });
    await expect(
      callGraphql(ctx(api), section, READ_OP, { owner: "o", repo: "r" }),
    ).rejects.toThrow(/repository: GRAPHQL RepoToggles: 422 bad value\. The API rejected/);
  });

  test("an op-level permission override renders its own grant at the graded level", async () => {
    const op: GraphqlOpDecl = {
      ...READ_OP,
      permission: { repo: ["contents"] },
    };
    const sectionWithWrite: SectionMeta = {
      ...section,
      graphql: {
        read: op,
        // A sibling WRITE on the same override permission grades the advice
        // at write - the overrideAdviceLevel contract, now over GraphQL ops.
        write: {
          name: "UpdateToggles",
          kind: "write",
          query: "mutation UpdateToggles($id: ID!) { x }",
          outcomes: { ok: "updated" },
          permission: { repo: ["contents"] },
        },
      },
    };
    const api = new MockApi({
      "GRAPHQL RepoToggles": {
        error: { status: 404, message: "Not Found", body: "", graphqlTypes: ["NOT_FOUND"] },
      },
    });
    let thrown: unknown;
    try {
      await callGraphql(ctx(api), sectionWithWrite, op, { owner: "o", repo: "r" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionDenied);
    expect((thrown as PermissionDenied).detail).toContain(grantFor({ repo: ["contents"] }));
    expect(overrideAdviceLevel(sectionWithWrite, { repo: ["contents"] })).toBe("write");
  });
});

describe("tryCallGraphql tolerance", () => {
  const tolerantOp = graphqlOp<{ owner: string; repo: string }>()({
    name: "RepoToggles",
    kind: "read",
    query:
      "query RepoToggles($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }",
    outcomes: { ok: "the toggles", NOT_FOUND: "the feature is not enabled" },
  });

  test("a declared observed type comes back as { error }", async () => {
    const api = new MockApi({
      "GRAPHQL RepoToggles": {
        error: { status: 404, message: "Not Found", body: "", graphqlTypes: ["NOT_FOUND"] },
      },
    });
    const result = await tryCallGraphql(ctx(api), section, tolerantOp, { owner: "o", repo: "r" });
    expect("error" in result && result.error.status).toBe(404);
  });

  test("an undeclared observed type still classifies through throwFor", async () => {
    const api = new MockApi({
      "GRAPHQL RepoToggles": {
        error: { status: 403, message: "denied", body: "", graphqlTypes: ["FORBIDDEN"] },
      },
    });
    await expect(
      tryCallGraphql(ctx(api), section, tolerantOp, { owner: "o", repo: "r" }),
    ).rejects.toThrow(PermissionDenied);
  });

  test("tolerance reads the observed types, never the folded status", async () => {
    // The 404 status alone would look like the declared NOT_FOUND, but the
    // response's actual types include an undeclared sibling: the status fold
    // is lossy, so the full set must be declared for tolerance to hold.
    const api = new MockApi({
      "GRAPHQL RepoToggles": {
        error: {
          status: 404,
          message: "mixed",
          body: "",
          graphqlTypes: ["NOT_FOUND", "UNPROCESSABLE"],
        },
      },
    });
    await expect(
      tryCallGraphql(ctx(api), section, tolerantOp, { owner: "o", repo: "r" }),
    ).rejects.toThrow(PermissionDenied);
  });

  test("an error without observed types (an HTTP-level failure) is never tolerated", async () => {
    const api = new MockApi({
      "GRAPHQL RepoToggles": { error: { status: 404, message: "Not Found", body: "" } },
    });
    await expect(
      tryCallGraphql(ctx(api), section, tolerantOp, { owner: "o", repo: "r" }),
    ).rejects.toThrow(PermissionDenied);
  });

  test("an explicit tolerate narrows below the declared set", async () => {
    const api = new MockApi({
      "GRAPHQL RepoToggles": {
        error: { status: 404, message: "Not Found", body: "", graphqlTypes: ["NOT_FOUND"] },
      },
    });
    await expect(
      tryCallGraphql(ctx(api), section, tolerantOp, { owner: "o", repo: "r" }, { tolerate: [] }),
    ).rejects.toThrow(PermissionDenied);
  });

  test("an explicit tolerate naming an undeclared outcome does not compile", () => {
    // graphqlOp preserves the literal `outcomes` keys, so the declared
    // subset is pinned at the type level (the REST `as const satisfies`
    // symmetry) - broadening tolerate is a compile error, not a runtime BUG.
    const api = new MockApi({});
    const smuggle = () =>
      tryCallGraphql(
        ctx(api),
        section,
        tolerantOp,
        { owner: "o", repo: "r" },
        // @ts-expect-error - UNPROCESSABLE is not a declared outcome of this op
        { tolerate: ["UNPROCESSABLE"] },
      );
    void smuggle;
    expect(api.calls).toHaveLength(0);
  });

  test("a RATE_LIMITED response always classifies as a rate limit", async () => {
    // RATE_LIMITED is not declarable as an outcome (the type excludes it),
    // so the observed type can never be tolerated and throwFor's rate-limit
    // branch renders the advice.
    const api = new MockApi({
      "GRAPHQL RepoToggles": {
        error: {
          status: 403,
          message: "slow down",
          body: "",
          rateLimited: true,
          graphqlTypes: ["RATE_LIMITED"],
        },
      },
    });
    await expect(
      tryCallGraphql(ctx(api), section, tolerantOp, { owner: "o", repo: "r" }),
    ).rejects.toThrow(/rate limit was hit/);
  });

  test("an INSUFFICIENT_SCOPES response always classifies as a denial", async () => {
    const forbiddenTolerant: GraphqlOpDecl = {
      ...READ_OP,
      outcomes: { ok: "the toggles", FORBIDDEN: "tolerated denial" },
    };
    const api = new MockApi({
      "GRAPHQL RepoToggles": {
        error: {
          status: 403,
          message: "scopes",
          body: "",
          graphqlTypes: ["FORBIDDEN", "INSUFFICIENT_SCOPES"],
        },
      },
    });
    await expect(
      tryCallGraphql(ctx(api), section, forbiddenTolerant, { owner: "o", repo: "r" }),
    ).rejects.toThrow(PermissionDenied);
  });
});

describe("declaration readers", () => {
  test("toleratedGraphqlErrors is the declared error-key set", () => {
    expect(toleratedGraphqlErrors(READ_OP)).toEqual([]);
    expect(
      toleratedGraphqlErrors({
        ...READ_OP,
        outcomes: { ok: "x", NOT_FOUND: "n", UNPROCESSABLE: "u" },
      }),
    ).toEqual(["NOT_FOUND", "UNPROCESSABLE"]);
  });

  test("the annotated-const idiom pins variables shapes at compile time", () => {
    // Type-level only; the body never runs. The annotation on READ_OP carries
    // its variables shape through GraphqlVariablesOf, so a missing or
    // misnamed variable at a helper call site does not compile.
    const _never = () => {
      const api = new MockApi({});
      // @ts-expect-error - `repo` is missing
      void callGraphql(ctx(api), section, READ_OP, { owner: "o" });
      // @ts-expect-error - `name` is not a declared variable
      void callGraphql(ctx(api), section, READ_OP, { owner: "o", name: "r" });
      // @ts-expect-error - a "read" op cannot carry a mutation document
      const _wrongKind: GraphqlOpDecl = {
        name: "X",
        kind: "read",
        query: "mutation X { y }",
        outcomes: { ok: "x" },
      };
      const _rateLimited: GraphqlOpDecl = {
        name: "Y",
        kind: "read",
        query: "query Y { y }",
        // @ts-expect-error - RATE_LIMITED is not a declarable outcome
        outcomes: { ok: "x", RATE_LIMITED: "never" },
      };
      const _hinted: GraphqlOpDecl = {
        name: "Z",
        kind: "read",
        query: "query Z { y }",
        outcomes: { ok: "x" },
        // @ts-expect-error - hints belong to REST endpoints only
        hints: { 422: "nope" },
      };
    };
    void _never;
  });
});

describe("listGraphqlConnection", () => {
  const pagedOp: GraphqlPaginatedReadDecl = {
    name: "RepoRules",
    kind: "read",
    query:
      "query RepoRules($owner: String!, $repo: String!, $cursor: String) { repository(owner: $owner, name: $repo) { rules(first: 100, after: $cursor) { nodes { id } pageInfo { hasNextPage endCursor } } } }",
    outcomes: { ok: "the rules" },
    connection: { path: ["repository", "rules"] },
  };

  /** A MockApi whose GraphQL route answers page bodies in sequence. */
  function pagedApi(pages: unknown[]): MockApi {
    let call = 0;
    const api = new MockApi({});
    api.tryGraphql = async (op, variables) => {
      api.calls.push({
        method: "GRAPHQL",
        path: op.name,
        payload: variables,
        graphqlKind: op.kind,
      });
      return { data: pages[Math.min(call++, pages.length - 1)] as Record<string, unknown> };
    };
    return api;
  }

  const page = (ids: string[], endCursor: string | null, hasNextPage: boolean) => ({
    repository: {
      rules: {
        nodes: ids.map((id) => ({ id })),
        pageInfo: { hasNextPage, endCursor },
      },
    },
  });

  test("walks the cursor until hasNextPage is false, passing null first", async () => {
    const api = pagedApi([page(["a", "b"], "CUR1", true), page(["c"], null, false)]);
    const listed = await listGraphqlConnection(ctx(api), section, pagedOp, {
      owner: "o",
      repo: "r",
    });
    expect(listed).toEqual({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    expect(api.calls.map((c) => (c.payload as { cursor: unknown }).cursor)).toEqual([null, "CUR1"]);
  });

  test("a declared error outcome comes back as { error } instead of throwing", async () => {
    // The probeAbsent posture over a connection: an operation declaring
    // NOT_FOUND (the environments pins read) has a fine-grained denial come
    // back as a value its caller reads as "resource absent".
    const tolerantPaged = {
      ...pagedOp,
      outcomes: { ok: "the rules", NOT_FOUND: "denied reads as absent" },
    };
    const api = new MockApi({
      "GRAPHQL RepoRules": {
        error: { status: 404, message: "Not Found", body: "", graphqlTypes: ["NOT_FOUND"] },
      },
    });
    const listed = await listGraphqlConnection(ctx(api), section, tolerantPaged, {
      owner: "o",
      repo: "r",
    });
    expect("error" in listed && listed.error.status).toBe(404);
  });

  test("a tolerated type arriving MID-walk still classifies as an error", async () => {
    // Absence describes the whole resource: a NOT_FOUND after a successful
    // first page means the connection vanished under the loop, and reading
    // it as "absent" would silently discard the collected pages.
    const tolerantPaged = {
      ...pagedOp,
      outcomes: { ok: "the rules", NOT_FOUND: "denied reads as absent" },
    };
    let call = 0;
    const api = new MockApi({});
    api.tryGraphql = async (op, variables) => {
      api.calls.push({
        method: "GRAPHQL",
        path: op.name,
        payload: variables,
        graphqlKind: op.kind,
      });
      if (call++ === 0) {
        return { data: page(["a"], "CUR1", true) as Record<string, unknown> };
      }
      return {
        error: { status: 404, message: "Not Found", body: "", graphqlTypes: ["NOT_FOUND"] },
      };
    };
    await expect(
      listGraphqlConnection(ctx(api), section, tolerantPaged, { owner: "o", repo: "r" }),
    ).rejects.toThrow(PermissionDenied);
  });

  test("a query without $cursor does not compile as a paginated read", () => {
    // The cursor contract moved from listGraphqlConnection's runtime BUG
    // throw into GraphqlPaginatedReadDecl's query template type.
    // @ts-expect-error - the paginated arm's query type requires $cursor
    const cursorless: GraphqlPaginatedReadDecl = {
      ...READ_OP,
      connection: { path: ["repository"] as const },
    };
    void cursorless;
  });

  test("a caller-supplied cursor variable does not compile (the loop owns it)", async () => {
    const api = pagedApi([page([], null, false)]);
    await listGraphqlConnection(ctx(api), section, pagedOp, {
      owner: "o",
      repo: "r",
      // @ts-expect-error - the connection loop owns the cursor variable
      cursor: "SMUGGLED",
    });
  });

  test("a response without the connection shape fails loudly", async () => {
    const api = pagedApi([{ repository: { rules: { nodes: "not-a-list" } } }]);
    await expect(
      listGraphqlConnection(ctx(api), section, pagedOp, { owner: "o", repo: "r" }),
    ).rejects.toThrow(/without a "repository.rules" connection/);
  });

  test("hasNextPage without a fresh endCursor fails instead of looping", async () => {
    const api = pagedApi([page(["a"], null, true)]);
    await expect(
      listGraphqlConnection(ctx(api), section, pagedOp, { owner: "o", repo: "r" }),
    ).rejects.toThrow(/hasNextPage without a new endCursor/);
  });

  test("errors inside the loop classify through throwFor", async () => {
    const api = new MockApi({
      "GRAPHQL RepoRules": { error: { status: 403, message: "denied", body: "" } },
    });
    await expect(
      listGraphqlConnection(ctx(api), section, pagedOp, { owner: "o", repo: "r" }),
    ).rejects.toThrow(PermissionDenied);
  });
});
