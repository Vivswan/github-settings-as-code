/**
 * The mock's GraphQL pipeline, tested at two levels:
 *   - through the wire (startMockServer + fetch) for the parts that need no
 *     declared operation: the POST-only rule, the body-shape rule, and the
 *     unknown-operationName violation (no section declares GraphQL ops yet,
 *     so every name is unknown at the wire);
 *   - through handleGraphqlRequest with FIXTURE operation/handler tables (the
 *     same injectable-dictionary idiom as assertHandlerCompleteness) for
 *     dispatch, the check-mode barrier, the permission gate and denial
 *     barrier, slug resolution from variables and node ids, the
 *     declared-outcomes response guard, and the fault/corruption hooks.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { TaggedGraphqlOp } from "../../../src/sections/registry.js";
import { ADMIN_SLUG, ADMIN_OWNER as OWNER, ADMIN_REPO as REPO } from "../constants.js";
import { parseScenario, type Scenario } from "../schema.js";
import {
  assertGraphqlHandlerCompleteness,
  type GraphqlHandlerContext,
  type GraphqlHandlerResult,
  graphqlDenialErrors,
  handleGraphqlRequest,
  isWriteRequest,
  type LoggedRequest,
  newPipelineRunState,
  type PipelineOptions,
  runPipeline,
  sectionForRequest,
} from "./routes.js";
import { type MockHandle, startMockServer } from "./server.js";
import { buildMultiState, buildState, mintNodeId } from "./state.js";

type Json = Record<string, unknown>;
type GraphqlHandler = (ctx: GraphqlHandlerContext) => GraphqlHandlerResult;

const AUTH = { authorization: "Bearer test-token", "x-github-api-version": "2022-11-28" };

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return parseScenario(
    { name: "graphql-unit", settings: {}, expect: { exit_code: 0 }, ...overrides },
    "graphql-pipeline.test.ts",
  );
}

// Fixture operations, tagged onto the real repository section so the
// permission gate resolves its real requirement (administration).
const G_READ: TaggedGraphqlOp = {
  name: "RepoToggles",
  kind: "read",
  query:
    "query RepoToggles($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id } }",
  outcomes: { ok: "the toggles" },
  section: "repository",
  role: "gToggles",
};
const G_READ_TOLERANT: TaggedGraphqlOp = {
  ...G_READ,
  name: "RepoTogglesProbe",
  role: "gProbe",
  outcomes: { ok: "the toggles", NOT_FOUND: "the feature is off" },
};
const G_WRITE: TaggedGraphqlOp = {
  name: "UpdateToggles",
  kind: "write",
  query:
    "mutation UpdateToggles($repositoryId: ID!, $hasWiki: Boolean!) { updateRepository(input: {repositoryId: $repositoryId, hasWiki: $hasWiki}) { clientMutationId } }",
  outcomes: { ok: "toggles updated" },
  section: "repository",
  role: "gUpdate",
};

const OPS: Readonly<Record<string, TaggedGraphqlOp>> = {
  "repository.gToggles": G_READ,
  "repository.gProbe": G_READ_TOLERANT,
  "repository.gUpdate": G_WRITE,
};

const HANDLERS: Record<string, GraphqlHandler> = {
  "repository.gToggles": ({ state }) => ({
    data: { repository: { id: String(state.repo.node_id) } },
  }),
  "repository.gProbe": () => ({ errors: [{ type: "NOT_FOUND", message: "feature off" }] }),
  "repository.gUpdate": ({ state, variables }) => {
    state.repo.has_wiki = variables.hasWiki === true;
    return { data: { updateRepository: { clientMutationId: null } } };
  },
};

/** The wire body for a fixture operation. */
function gqlBody(op: TaggedGraphqlOp, variables: Json): Json {
  return { query: op.query, operationName: op.name, variables };
}

function options(s: Scenario, overrides: Partial<PipelineOptions> = {}): PipelineOptions {
  return {
    scenario: s,
    working: { mode: "single", state: buildState(s.live_state, s.owner_kind) },
    checkMode: s.inputs?.mode === "check",
    ...newPipelineRunState(),
    ...overrides,
  };
}

function baseLog(body: unknown): LoggedRequest {
  return { method: "POST", pathname: "/graphql", query: "", status: 0, body };
}

/** Dispatch one fixture operation through the pipeline branch. */
function dispatch(op: TaggedGraphqlOp, variables: Json, opts: PipelineOptions, method = "POST") {
  const body = gqlBody(op, variables);
  return handleGraphqlRequest({ method, body }, opts, baseLog(body), OPS, HANDLERS);
}

let handle: MockHandle | undefined;
afterEach(async () => {
  await handle?.stop();
  handle = undefined;
});

describe("GraphQL wire contract (through the server)", () => {
  test("a non-POST /graphql is a violation", async () => {
    handle = await startMockServer(scenario());
    const res = await fetch(`${handle.url}/graphql`, { method: "GET", headers: AUTH });
    expect(res.status).toBe(400);
    expect(handle.violations.join("\n")).toContain("GraphQL requests must be POST");
  });

  test("a body without query/operationName/variables is a violation", async () => {
    handle = await startMockServer(scenario());
    const res = await fetch(`${handle.url}/graphql`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ query: "query X { viewer { login } }" }),
    });
    expect(res.status).toBe(400);
    expect(handle.violations.join("\n")).toContain(
      "must carry query (string), operationName (string), and variables (object)",
    );
  });

  test("an operationName no section declares is a loud violation", async () => {
    handle = await startMockServer(scenario());
    const res = await fetch(`${handle.url}/graphql`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ query: "query Nope { x }", operationName: "Nope", variables: {} }),
    });
    expect(res.status).toBe(400);
    expect(handle.violations.join("\n")).toContain(
      'no GraphQL operation named "Nope" is declared by any section',
    );
  });
});

describe("GraphQL dispatch and logging", () => {
  test("a read dispatches to its handler and logs its operation and kind", () => {
    const result = dispatch(G_READ, { owner: OWNER, repo: REPO }, options(scenario()));
    expect(result.violation).toBeUndefined();
    expect(result.response.status).toBe(200);
    const data = (result.response.body as { data: Json }).data;
    expect(data.repository).toBeDefined();
    expect(result.log.graphql).toEqual({ operationName: "RepoToggles", kind: "read" });
    expect(isWriteRequest(result.log)).toBe(false);
  });

  test("a write mutates the state and classifies as a write", () => {
    const opts = options(scenario());
    const state = opts.working.mode === "single" ? opts.working.state : undefined;
    const id = mintNodeId("repo", ADMIN_SLUG, "");
    const result = dispatch(G_WRITE, { repositoryId: id, hasWiki: true }, opts);
    expect(result.violation).toBeUndefined();
    expect(state?.repo.has_wiki).toBe(true);
    expect(isWriteRequest(result.log)).toBe(true);
  });

  test("a single-mode mutation without a decodable node id is a violation", () => {
    // The node-id contract binds in EVERY mode, or a section could look
    // green against the single-repo harness and only fail under multi.
    const result = dispatch(
      G_WRITE,
      { repositoryId: "R_kgDOnotOurs", hasWiki: true },
      options(scenario()),
    );
    expect(result.violation).toContain("carries no decodable mock node id");
  });

  test("a single-mode mutation naming a foreign slug is a violation", () => {
    const result = dispatch(
      G_WRITE,
      { repositoryId: mintNodeId("repo", "acme/other", ""), hasWiki: true },
      options(scenario()),
    );
    expect(result.violation).toContain('node ids of "acme/other"');
    expect(result.violation).toContain(`serves only "${ADMIN_SLUG}"`);
  });

  test("sectionForRequest attributes a /graphql request through its body", () => {
    // Attribution reads the live registry, where no section declares ops yet,
    // so an unknown name resolves null - the REST fallback stays intact.
    expect(sectionForRequest("POST", "/graphql", gqlBody(G_READ, {}))).toBeNull();
    expect(sectionForRequest("GET", `/repos/${OWNER}/${REPO}`)).toBe("repository");
  });
});

describe("GraphQL check-mode barrier", () => {
  test("a write in check mode is a violation, before the permission gate", () => {
    const s = scenario({
      inputs: { mode: "check" },
      token_permissions: { administration: "none" },
    });
    const result = dispatch(
      G_WRITE,
      { repositoryId: mintNodeId("repo", ADMIN_SLUG, "") },
      options(s),
    );
    expect(result.violation).toContain("GraphQL write in check mode (UpdateToggles)");
  });

  test("a read in check mode passes", () => {
    const result = dispatch(
      G_READ,
      { owner: OWNER, repo: REPO },
      options(scenario({ inputs: { mode: "check" } })),
    );
    expect(result.violation).toBeUndefined();
    expect(result.response.status).toBe(200);
  });
});

describe("GraphQL denial styles", () => {
  test("graphqlDenialErrors mirrors denialResponse per style and kind", () => {
    expect(graphqlDenialErrors("fine_grained", "read")[0]?.type).toBe("NOT_FOUND");
    expect(graphqlDenialErrors("fine_grained", "write")[0]?.type).toBe("FORBIDDEN");
    expect(graphqlDenialErrors(403, "read")[0]?.type).toBe("FORBIDDEN");
    expect(graphqlDenialErrors(404, "write")[0]?.type).toBe("NOT_FOUND");
    for (const style of [403, 404, "fine_grained"] as const) {
      for (const kind of ["read", "write"] as const) {
        for (const entry of graphqlDenialErrors(style, kind)) {
          expect(entry.message.toLowerCase()).not.toContain("rate limit");
        }
      }
    }
  });

  test("a denied request answers HTTP 200 with data:null and logs deniedBy", () => {
    const s = scenario({ token_permissions: { administration: "none" } });
    const result = dispatch(G_READ, { owner: OWNER, repo: REPO }, options(s));
    expect(result.response.status).toBe(200);
    expect(result.response.body).toEqual({
      data: null,
      errors: [
        { type: "NOT_FOUND", message: "Could not resolve to a Repository with the given name" },
      ],
    });
    expect(result.log.deniedBy).toBe("administration");
    expect(result.log.status).toBe(200);
  });
});

describe("GraphQL denial barrier (shared with REST)", () => {
  test("a fatal denied GraphQL read arms the barrier for a later GraphQL write", () => {
    const s = scenario({ token_permissions: { administration: "none" } });
    const opts = options(s);
    const read = dispatch(G_READ, { owner: OWNER, repo: REPO }, opts);
    expect(read.violation).toBeUndefined();
    const write = dispatch(G_WRITE, { repositoryId: mintNodeId("repo", ADMIN_SLUG, "") }, opts);
    expect(write.violation).toContain(
      "write to GRAPHQL UpdateToggles reached the server after a fatal denied read",
    );
  });

  test("a denied GraphQL read arms the barrier for a later REST write too", () => {
    const s = scenario({ token_permissions: { administration: "none" } });
    const opts = options(s);
    dispatch(G_READ, { owner: OWNER, repo: REPO }, opts);
    const rest = runPipeline(
      {
        method: "PATCH",
        rawPath: `/repos/${OWNER}/${REPO}`,
        query: {},
        rawQuery: "",
        headers: new Headers(AUTH),
        body: { has_wiki: true },
      },
      opts,
    );
    expect(rest.violation).toContain("reached the server after a fatal denied read");
  });

  test("a TOLERATED denied read (declared NOT_FOUND outcome) does not arm", () => {
    const s = scenario({ token_permissions: { administration: "none" } });
    const opts = options(s);
    const read = dispatch(G_READ_TOLERANT, { owner: OWNER, repo: REPO }, opts);
    expect(read.violation).toBeUndefined();
    const write = dispatch(G_WRITE, { repositoryId: mintNodeId("repo", ADMIN_SLUG, "") }, opts);
    expect(write.violation).toBeUndefined();
  });

  test("an ADVISORY denied read does not arm", () => {
    const advisory: TaggedGraphqlOp = { ...G_READ, advisory: true };
    const ops = { ...OPS, "repository.gToggles": advisory };
    const s = scenario({ token_permissions: { administration: "none" } });
    const opts = options(s);
    const body = gqlBody(advisory, { owner: OWNER, repo: REPO });
    handleGraphqlRequest({ method: "POST", body }, opts, baseLog(body), ops, HANDLERS);
    const write = dispatch(G_WRITE, { repositoryId: mintNodeId("repo", ADMIN_SLUG, "") }, opts);
    expect(write.violation).toBeUndefined();
  });
});

describe("GraphQL multi-repo slug resolution", () => {
  function multiOptions(s: Scenario): PipelineOptions {
    const multi = buildMultiState(
      {
        "acme/alpha": { settingsYaml: null },
        "acme/beta": { settingsYaml: null, permissions: { administration: "none" } },
      },
      undefined,
      "org",
    );
    return options(s, { working: { mode: "multi", multi } });
  }

  test("a read resolves its slug from $owner/$repo and grades that slug's mask", () => {
    const opts = multiOptions(scenario());
    const allowed = dispatch(G_READ, { owner: "acme", repo: "alpha" }, opts);
    expect(allowed.response.status).toBe(200);
    expect(allowed.log.deniedBy).toBeUndefined();
    const denied = dispatch(G_READ, { owner: "acme", repo: "beta" }, opts);
    expect(denied.log.deniedBy).toBe("administration");
  });

  test("a read without $owner/$repo variables is a violation", () => {
    const result = dispatch(G_READ, { owner: "acme" }, multiOptions(scenario()));
    expect(result.violation).toContain("carries no $owner/$repo variables");
  });

  test("a mutation routes by its NESTED node id and mutates only that slug", () => {
    const opts = multiOptions(scenario());
    const multi = opts.working.mode === "multi" ? opts.working.multi : undefined;
    // The fixture starts every repo at has_wiki: true, so flipping alpha to
    // false is what proves the write landed on alpha and ONLY alpha.
    const id = mintNodeId("repo", "acme/alpha", "");
    const result = dispatch(G_WRITE, { input: { repositoryId: id }, hasWiki: false }, opts);
    expect(result.violation).toBeUndefined();
    expect(multi?.repos.get("acme/alpha")?.repo.has_wiki).toBe(false);
    expect(multi?.repos.get("acme/beta")?.repo.has_wiki).toBe(true);
  });

  test("a mutation without a decodable node id is a violation", () => {
    const result = dispatch(
      G_WRITE,
      { repositoryId: "R_kgDOnotOurs", hasWiki: true },
      multiOptions(scenario()),
    );
    expect(result.violation).toContain("carries no decodable mock node id");
  });

  test("a mutation whose ids span two repositories is a violation", () => {
    const result = dispatch(
      G_WRITE,
      {
        repositoryId: mintNodeId("repo", "acme/alpha", ""),
        other: mintNodeId("environment", "acme/beta", "prod"),
      },
      multiOptions(scenario()),
    );
    expect(result.violation).toContain("node ids of several repositories");
  });

  test("a decodable id naming an unknown slug is a violation", () => {
    const result = dispatch(
      G_WRITE,
      { repositoryId: mintNodeId("repo", "acme/ghost", "") },
      multiOptions(scenario()),
    );
    expect(result.violation).toContain('names no known target slug ("acme/ghost")');
  });
});

describe("GraphQL response guard and chaos", () => {
  test("a handler error type within the declared outcomes is served, others are violations", () => {
    const probe = dispatch(G_READ_TOLERANT, { owner: OWNER, repo: REPO }, options(scenario()));
    expect(probe.violation).toBeUndefined();
    expect(probe.response.body).toEqual({
      data: null,
      errors: [{ type: "NOT_FOUND", message: "feature off" }],
    });

    const rogue: Record<string, GraphqlHandler> = {
      ...HANDLERS,
      "repository.gToggles": () => ({ errors: [{ type: "UNPROCESSABLE", message: "nope" }] }),
    };
    const body = gqlBody(G_READ, { owner: OWNER, repo: REPO });
    const result = handleGraphqlRequest(
      { method: "POST", body },
      options(scenario()),
      baseLog(body),
      OPS,
      rogue,
    );
    expect(result.violation).toContain(
      "answered error type(s) [UNPROCESSABLE] the operation does not declare",
    );
  });

  test("faults address GraphQL ops by their section.role key", () => {
    const opts = options(scenario(), {
      faults: [{ key: "repository.gToggles", kind: "rate_limit_403" }],
    });
    const faulted = dispatch(G_READ, { owner: OWNER, repo: REPO }, opts);
    expect(faulted.response.status).toBe(403);
    expect(faulted.offSpecBody).toBe(true);
    expect(opts.faultCounts.get("repository.gToggles")).toBe(1);
    // The fault budget spent, the next request serves normally.
    const next = dispatch(G_READ, { owner: OWNER, repo: REPO }, opts);
    expect(next.response.status).toBe(200);
  });

  test("chaos corruption addresses GraphQL ops by the same key", () => {
    const opts = options(scenario(), {
      corrupt: { key: "repository.gToggles", mode: "wrong_shape" },
    });
    const corrupted = dispatch(G_READ, { owner: OWNER, repo: REPO }, opts);
    expect(corrupted.response.body).toBe(42);
    expect(corrupted.offSpecBody).toBe(true);
  });
});

describe("assertGraphqlHandlerCompleteness", () => {
  test("both drift directions fail loudly", () => {
    expect(() => assertGraphqlHandlerCompleteness(OPS, {})).toThrow(
      /GraphQL operations with no mock handler in routes\.ts/,
    );
    expect(() => assertGraphqlHandlerCompleteness({}, HANDLERS)).toThrow(
      /GraphQL handlers naming no declared operation/,
    );
  });

  test("the live tables (both empty of GraphQL today) are in lockstep", () => {
    expect(() => assertGraphqlHandlerCompleteness()).not.toThrow();
  });
});
