/**
 * The plan executor's own contract: operations run in order through the
 * declared endpoints, thunks seal at execution, and a role that is not a
 * declared WRITE is refused before any request leaves. The refusals are the
 * runtime backstop behind the PlannedOp type - a plan built through the
 * erased view (the engine's own) carries bare string roles - so each one is
 * exercised here against a client that would happily answer.
 */

import { describe, expect, test } from "bun:test";
import { executePlan } from "../../src/engine/execute.js";
import type { EndpointDecl } from "../../src/sections/contract/endpoints.js";
import { graphqlOp } from "../../src/sections/contract/graphql.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import type { ExecTools, SectionPlan } from "../../src/sections/contract/plan.js";
import { MockApi } from "../mock-api.js";

const REPO = { owner: "o", name: "r", slug: "o/r" } as const;

const READ_OP = graphqlOp<{ owner: string; repo: string }>()({
  name: "ExecutorRead",
  kind: "read",
  query: "query ExecutorRead($owner: String!, $repo: String!) { repository { id } }",
  outcomes: { ok: "the repository" },
});

const WRITE_OP = graphqlOp<Record<string, never>>()({
  name: "ExecutorWrite",
  kind: "write",
  query: "mutation ExecutorWrite { noop { id } }",
  outcomes: { ok: "written" },
});

const SECTION: SectionMeta = {
  key: "labels",
  permission: { repo: ["administration"] },
  undeclaredDefault: "delete",
  endpoints: {
    list: {
      route: "GET /repos/{owner}/{repo}/labels",
      statuses: { 200: "the labels" },
    },
    create: {
      route: "POST /repos/{owner}/{repo}/labels",
      statuses: { 201: "created" },
    },
    // A key the numeric role 0 would coerce onto if the executor let it.
    "0": {
      route: "DELETE /repos/{owner}/{repo}/labels/{name}",
      statuses: { 204: "deleted" },
    },
  } satisfies Record<string, EndpointDecl>,
  graphql: { read: READ_OP, write: WRITE_OP },
};

const TOOLS: ExecTools = { resolveSecret: (reference) => `plain(${reference})` };

/** A plan carrying one operation under `role`; drift is irrelevant here. */
function planOf(op: Partial<SectionPlan["ops"][number]> & { role: string }): SectionPlan {
  return {
    ops: [{ drift: ["drifted"], change: "did the thing", ...op }],
    notes: [],
    drift: [],
  };
}

describe("executePlan", () => {
  test("runs declared writes in order, sealing payload thunks at execution", async () => {
    const api = new MockApi({}).allowMutations("POST /repos/o/r/labels", "GRAPHQL ExecutorWrite");
    const plan: SectionPlan = {
      ops: [
        {
          role: "create",
          payload: (exec) => ({ name: "bug", secret: exec.resolveSecret("$TOKEN") }),
          drift: ["labels[bug]: missing"],
          change: 'created label "bug"',
        },
        { role: "write", variables: {}, drift: ["toggle off"], change: "flipped the toggle" },
      ],
      notes: [],
      drift: [],
    };
    const execution = await executePlan(plan, SECTION, api, REPO, TOOLS);
    expect(execution).toEqual({
      status: "applied",
      changes: ['created label "bug"', "flipped the toggle"],
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/labels",
      "GRAPHQL ExecutorWrite",
    ]);
    // The thunk sealed at execution, not at plan time.
    expect(api.mutations()[0]?.payload).toEqual({ name: "bug", secret: "plain($TOKEN)" });
  });

  test("a failing operation stops the plan, keeping the changes already on the wire", async () => {
    // The first operation succeeds and the second is rejected: the failed
    // execution must still carry the first one's change line, because the
    // API has no transactions and that mutation really happened.
    const api = new MockApi({
      "GRAPHQL ExecutorWrite": { data: {} },
      "POST /repos/o/r/labels": { error: { status: 422, message: "Validation Failed", body: "" } },
    });
    const plan: SectionPlan = {
      ops: [
        { role: "write", variables: {}, drift: ["toggle off"], change: "flipped the toggle" },
        { role: "create", drift: ["labels[bug]: missing"], change: 'created label "bug"' },
      ],
      notes: [],
      drift: [],
    };
    const execution = await executePlan(plan, SECTION, api, REPO, TOOLS);
    expect(execution.status).toBe("failed");
    expect(execution.changes).toEqual(["flipped the toggle"]);
    expect(String((execution as { error: unknown }).error)).toContain("422");
  });

  test("a thunk receives a frozen projection holding the resolver and nothing else", async () => {
    // The engine hands executePlan its apply context, which also carries the
    // client; the thunk must see neither that object nor anything on it.
    const api = new MockApi({}).allowMutations("POST /repos/o/r/labels");
    const leaky = { ...TOOLS, api, repo: REPO, check: false as const };
    let seen: unknown;
    const plan = planOf({
      role: "create",
      payload: (exec) => {
        seen = exec;
        return { name: exec.resolveSecret("$X") };
      },
    });
    const execution = await executePlan(plan, SECTION, api, REPO, leaky);
    expect(execution.status).toBe("applied");
    expect(Object.keys(seen as object)).toEqual(["resolveSecret"]);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(seen).not.toBe(leaky);
    expect(api.mutations()[0]?.payload).toEqual({ name: "plain($X)" });
    // And by type: ExecTools has no client to reach for.
    // @ts-expect-error a payload thunk cannot read a client off its tools
    planOf({ role: "create", payload: (exec) => ({ leaked: exec.api }) });
  });

  // The refusals: each names a role the erased plan type admits but the
  // executor must never issue, and each runs against a client that would
  // otherwise answer, so a missing guard fails the test loudly.
  const refused: ReadonlyArray<{ what: string; role: string; message: RegExp }> = [
    { what: "a REST read role", role: "list", message: /is a read endpoint/ },
    { what: "a GraphQL read role", role: "read", message: /is a GraphQL read operation/ },
    { what: "an undeclared role", role: "typo", message: /names no declared endpoint/ },
    // Inherited names resolve through a plain `dict[role]` lookup; the
    // executor must read own properties only.
    { what: "an inherited role (constructor)", role: "constructor", message: /names no declared/ },
    { what: "an inherited role (toString)", role: "toString", message: /names no declared/ },
    // Non-string roles: a number would coerce onto a matching key, a symbol
    // would enter the property-key path; both are refused before any lookup.
    { what: "a numeric role", role: 0 as unknown as string, message: /role is a number/ },
    {
      what: "a symbol role",
      role: Symbol("create") as unknown as string,
      message: /role is a symbol/,
    },
  ];
  for (const { what, role, message } of refused) {
    test(`refuses ${what} before any request leaves`, async () => {
      const api = new MockApi(
        {
          "GET /repos/o/r/labels": { data: [] },
          "GRAPHQL ExecutorRead": { data: { repository: {} } },
        },
        { unroutedMutations: "succeed" },
      );
      const execution = await executePlan(planOf({ role }), SECTION, api, REPO, TOOLS);
      expect(execution.status).toBe("failed");
      expect(execution.changes).toEqual([]);
      expect(String((execution as { error: unknown }).error)).toMatch(message);
      expect(api.calls).toEqual([]);
    });
  }
});
