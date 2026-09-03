/**
 * The plan executor's own contract: operations run in order through the
 * declared endpoints, thunks seal at execution, and a role that is not a
 * declared WRITE is refused before any request leaves. The refusals are the
 * runtime backstop behind the PlannedOp type - a plan built through the
 * erased view (the engine's own) carries bare string roles - so each one is
 * exercised here against a client that would happily answer. The change
 * line's one rule is pinned from every side: it records only when the
 * request, the change render, and the capture hook all succeeded.
 */

import { describe, expect, test } from "bun:test";
import { executePlan } from "../../src/engine/execute.js";
import type { EndpointDecl } from "../../src/sections/contract/endpoints.js";
import { PermissionDenied } from "../../src/sections/contract/errors.js";
import { graphqlOp } from "../../src/sections/contract/graphql.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import {
  driftOf,
  type ExecTools,
  type PlannedOp,
  planCheckNotes,
  planContext,
  planDrift,
  type SectionPlan,
  type ToleratedOutcome,
} from "../../src/sections/contract/plan.js";
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

const SECTION = {
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
      statuses: { 201: "created", 409: "a label run is in progress", 422: "rejected" },
    },
    // A key the numeric role 0 would coerce onto if the executor let it.
    "0": {
      route: "DELETE /repos/{owner}/{repo}/labels/{name}",
      statuses: { 204: "deleted" },
    },
    resend: {
      route: "PATCH /repos/{owner}/{repo}/labels/{name}",
      statuses: { 200: "re-sent" },
      unverifiable: true,
    },
  } satisfies Record<string, EndpointDecl>,
  graphql: { read: READ_OP, write: WRITE_OP },
} satisfies SectionMeta;

const TOOLS: ExecTools = { resolveSecret: (reference) => `plain(${reference})` };

const CONFLICT = { status: 409, message: "Conflict", body: "" };
const REJECTED = { status: 422, message: "Validation Failed", body: "" };

/** A plan carrying one operation under `role`; drift is irrelevant here. */
function planOf(op: Partial<SectionPlan["ops"][number]> & { role: string }): SectionPlan {
  return {
    ops: [{ drift: ["drifted"], change: "did the thing", ...op }],
    notes: [],
    drift: [],
  };
}

function errorOf(execution: Awaited<ReturnType<typeof executePlan>>): string {
  return String((execution as { error: unknown }).error);
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
      notes: [],
      landed: 2,
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/labels",
      "GRAPHQL ExecutorWrite",
    ]);
    // The thunk sealed at execution, not at plan time.
    expect(api.mutations()[0]?.payload).toEqual({ name: "bug", secret: "plain($TOKEN)" });
  });

  test("async thunks are awaited, and a thunk may read through the plan's port after an earlier write", async () => {
    // A value the request needs (a sealing key) exists only once an earlier
    // operation ran, so the thunk reads it at execution through the read-only
    // port plan() closed over, awaited before the request leaves.
    const api = new MockApi({
      "GET /repos/o/r/labels?per_page=100&page=1": { data: [{ name: "live" }] },
    }).allowMutations("POST /repos/o/r/labels", "GRAPHQL ExecutorWrite");
    const port = planContext(SECTION, api, REPO).read;
    const plan: SectionPlan = {
      ops: [
        {
          role: "create",
          payload: { name: "first" },
          drift: ["labels[first]: missing"],
          change: "1",
        },
        {
          role: "create",
          payload: async () => ({ copies: JSON.stringify(await port.list.listAll()) }),
          drift: ["labels[copy]: missing"],
          change: "2",
        },
        {
          role: "write",
          variables: async () => ({ deferred: true }),
          drift: ["toggle off"],
          change: "3",
        },
      ],
      notes: [],
      drift: [],
    };
    const execution = await executePlan(plan, SECTION, api, REPO, TOOLS);
    expect(execution).toEqual({
      status: "applied",
      changes: ["1", "2", "3"],
      notes: [],
      landed: 3,
    });
    // The deferred read sits between the two writes, where the thunk ran.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/o/r/labels",
      "GET /repos/o/r/labels?per_page=100&page=1",
      "POST /repos/o/r/labels",
      "GRAPHQL ExecutorWrite",
    ]);
    expect(api.mutations()[1]?.payload).toEqual({ copies: '[{"name":"live"}]' });
    expect(api.mutations()[2]?.payload).toEqual({ deferred: true });
  });

  test("a failing operation stops the plan, keeping the changes already on the wire", async () => {
    // The first operation succeeds and the second is rejected: the failed
    // execution must still carry the first one's change line, because the
    // API has no transactions and that mutation really happened.
    const api = new MockApi({
      "GRAPHQL ExecutorWrite": { data: {} },
      "POST /repos/o/r/labels": { error: REJECTED },
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
    expect(errorOf(execution)).toContain("422");
  });

  test("an operation's describe label leads the failure message, REST and GraphQL alike", async () => {
    const api = new MockApi({
      "POST /repos/o/r/labels": { error: REJECTED },
      "GRAPHQL ExecutorWrite": { error: { status: 502, message: "Bad Gateway", body: "" } },
    });
    const rest = await executePlan(
      planOf({ role: "create", describe: 'creating label "bug"' }),
      SECTION,
      api,
      REPO,
      TOOLS,
    );
    expect(errorOf(rest)).toContain(
      'creating label "bug" failed - POST /repos/o/r/labels: 422 Validation Failed',
    );
    const graphql = await executePlan(
      planOf({ role: "write", variables: {}, describe: "flipping the toggle" }),
      SECTION,
      api,
      REPO,
      TOOLS,
    );
    expect(errorOf(graphql)).toContain("flipping the toggle failed - GRAPHQL ExecutorWrite: 502");
  });

  test("a change thunk renders from the response once the request landed, one line or several", async () => {
    const api = new MockApi({
      "POST /repos/o/r/labels": { data: { id: 7, name: "bug" } },
      "GRAPHQL ExecutorWrite": { data: { noop: { moved: ["a", "b"] } } },
    });
    const plan: SectionPlan = {
      ops: [
        {
          role: "create",
          drift: ["labels[bug]: missing"],
          change: (response) => `created label #${(response as { id: number }).id}`,
        },
        {
          role: "write",
          variables: {},
          drift: ["toggle off"],
          change: (response) => {
            const [head, ...tail] = (response as { noop: { moved: [string, ...string[]] } }).noop
              .moved;
            return [`moved ${head}`, ...tail.map((key) => `moved ${key}`)];
          },
        },
      ],
      notes: [],
      drift: [],
    };
    const execution = await executePlan(plan, SECTION, api, REPO, TOOLS);
    expect(execution).toEqual({
      status: "applied",
      changes: ["created label #7", "moved a", "moved b"],
      notes: [],
      landed: 2,
    });
  });

  test.each<[what: string, change: SectionPlan["ops"][number]["change"]]>([
    ["an empty change line", ""],
    ["a thunk rendering no line (erased view only)", () => [] as unknown as readonly [string]],
  ])("%s is a bug: the request landed, so apply must report it", async (_what, change) => {
    const api = new MockApi({}).allowMutations("POST /repos/o/r/labels");
    const execution = await executePlan(
      planOf({ role: "create", change }),
      SECTION,
      api,
      REPO,
      TOOLS,
    );
    expect(execution).toEqual({
      status: "failed",
      changes: [],
      notes: [],
      landed: 1,
      error: expect.objectContaining({
        message: expect.stringMatching(
          /BUG: labels: operation "create" rendered no change line for a request that landed/,
        ),
      }),
    });
  });

  test("a change thunk that throws fails the operation without its line, after the request landed", async () => {
    // The verification lives in the thunk (an echo reporting the old value):
    // the mutation really happened, so it is counted as landed and reported
    // like a rejected request, with the line absent and the thunk's own error.
    const api = new MockApi({}).allowMutations("POST /repos/o/r/labels");
    let captured = false;
    const plan = planOf({
      role: "create",
      change: () => {
        throw new Error("the write did not take");
      },
      capture: () => {
        captured = true;
      },
    });
    const execution = await executePlan(plan, SECTION, api, REPO, TOOLS);
    expect(execution).toEqual({
      status: "failed",
      changes: [],
      notes: [],
      landed: 1,
      error: new Error("the write did not take"),
    });
    expect(api.mutations()).toHaveLength(1);
    // The render failed, so the hook after it never ran.
    expect(captured).toBe(false);
  });

  test("the capture hook receives the response before the line records, so its throw fails the operation without the line", async () => {
    const api = new MockApi({
      "POST /repos/o/r/labels": { data: { id: 7, node_id: "L_7" } },
      "GRAPHQL ExecutorWrite": { data: { toggled: true } },
    });
    const seen: unknown[] = [];
    const plan: SectionPlan = {
      ops: [
        {
          role: "create",
          drift: ["labels[bug]: missing"],
          change: 'created label "bug"',
          capture: (response) => {
            seen.push(response);
          },
        },
        {
          role: "write",
          variables: {},
          drift: ["toggle off"],
          change: "flipped the toggle",
          capture: () => {
            throw new Error("the response carried no node id");
          },
        },
        { role: "create", drift: ["labels[next]: missing"], change: "never reached" },
      ],
      notes: [],
      drift: [],
    };
    const execution = await executePlan(plan, SECTION, api, REPO, TOOLS);
    expect(seen).toEqual([{ id: 7, node_id: "L_7" }]);
    // The mutation whose capture threw DID land, but its line is absent -
    // the one failure rule - and the operation after it never runs.
    expect(execution).toEqual({
      status: "failed",
      changes: ['created label "bug"'],
      notes: [],
      landed: 2,
      error: new Error("the response carried no node id"),
    });
    expect(api.mutations()).toHaveLength(2);
  });

  test.each<[hook: string, op: Partial<SectionPlan["ops"][number]>]>([
    ["capture hook", { capture: (async () => {}) as unknown as () => void }],
    ["change thunk", { change: (async () => "late") as unknown as () => string }],
    // A REJECTING hook: the BUG is the report, and the discarded promise
    // must not surface a second time as an unhandled rejection.
    [
      "capture hook",
      {
        capture: (async () => {
          throw new Error("late failure");
        }) as unknown as () => void,
      },
    ],
    // A custom thenable whose then() throws still reports the canonical BUG.
    [
      "capture hook",
      {
        capture: (() =>
          new Proxy(
            {},
            {
              get: (_target, key) =>
                key === "then"
                  ? () => {
                      throw new Error("hostile then");
                    }
                  : undefined,
            },
          )) as unknown as () => void,
      },
    ],
  ])(
    "an async %s is a bug caught before the line records: the request landed, the line is absent",
    async (hook, op) => {
      const api = new MockApi({}).allowMutations("POST /repos/o/r/labels");
      const execution = await executePlan(
        planOf({ role: "create", ...op }),
        SECTION,
        api,
        REPO,
        TOOLS,
      );
      expect(execution).toEqual({
        status: "failed",
        changes: [],
        notes: [],
        landed: 1,
        error: expect.objectContaining({
          message: `BUG: labels: the ${hook} of operation "create" returned a promise; it must be synchronous`,
        }),
      });
    },
  );

  test("a failing request never reaches the change thunk or the capture hook", async () => {
    const api = new MockApi({ "POST /repos/o/r/labels": { error: REJECTED } });
    let rendered = false;
    let captured = false;
    const plan = planOf({
      role: "create",
      change: () => {
        rendered = true;
        return "never";
      },
      capture: () => {
        captured = true;
      },
    });
    const execution = await executePlan(plan, SECTION, api, REPO, TOOLS);
    expect(execution.status).toBe("failed");
    expect(rendered).toBe(false);
    expect(captured).toBe(false);
  });

  test("a tolerated status renders the operation's own outcome, never throwFor's", async () => {
    // One tolerated 409 turns into a note (the plan goes on, no change line);
    // the next turns into the section's own failure advice. Neither reaches
    // throwFor, whose 409 text would tell the user to fix the settings file.
    const api = new MockApi({
      "POST /repos/o/r/labels": { error: CONFLICT },
      "GRAPHQL ExecutorWrite": { data: {} },
    });
    const plan: SectionPlan = {
      ops: [
        {
          role: "create",
          drift: ["labels[bug]: missing"],
          change: 'created label "bug"',
          tolerate: {
            statuses: [409],
            outcome: (error) => ({
              note: `labels: a label run is in progress, so the create was not applied (${error.status})`,
            }),
          },
        },
        { role: "write", variables: {}, drift: ["toggle off"], change: "flipped the toggle" },
        {
          role: "create",
          drift: ["labels[next]: missing"],
          change: 'created label "next"',
          tolerate: {
            statuses: [409],
            outcome: (error) => ({
              failure: `labels: POST answered ${error.status} ${error.message}; a label run is in progress, re-run after it finishes`,
            }),
          },
        },
      ],
      notes: [],
      drift: [],
    };
    const execution = await executePlan(plan, SECTION, api, REPO, TOOLS);
    expect(execution).toEqual({
      status: "failed",
      changes: ["flipped the toggle"],
      notes: ["labels: a label run is in progress, so the create was not applied (409)"],
      // A tolerated status is a request GitHub refused, so it never lands.
      landed: 1,
      error: new Error(
        "labels: POST answered 409 Conflict; a label run is in progress, re-run after it finishes",
      ),
    });
  });

  test("tolerated statuses default to the declared errors; an explicit list narrows them; the rest classify through throwFor", async () => {
    const outcome = (error: { status: number }): ToleratedOutcome => ({
      note: `absorbed ${error.status}`,
    });
    const answering = (status: number, message: string) =>
      new MockApi({ "POST /repos/o/r/labels": { error: { status, message, body: "" } } });
    // Omitted statuses: both declared errors (409, 422) are absorbed.
    for (const [status, message] of [
      [409, "Conflict"],
      [422, "Validation Failed"],
    ] as const) {
      const absorbed = await executePlan(
        planOf({ role: "create", tolerate: { outcome } }),
        SECTION,
        answering(status, message),
        REPO,
        TOOLS,
      );
      expect(absorbed).toEqual({
        status: "applied",
        changes: [],
        notes: [`absorbed ${status}`],
        landed: 0,
      });
    }
    // An explicit subset: the declared 422 outside it classifies through
    // throwFor exactly as if undeclared.
    const narrowed = await executePlan(
      planOf({ role: "create", tolerate: { statuses: [409], outcome } }),
      SECTION,
      answering(422, "Validation Failed"),
      REPO,
      TOOLS,
    );
    expect(narrowed.status).toBe("failed");
    expect(narrowed.notes).toEqual([]);
    expect(errorOf(narrowed)).toContain("422 Validation Failed");
    // An undeclared status under the default: throwFor's classification, a
    // PermissionDenied here, not the operation's outcome.
    const denied = await executePlan(
      planOf({ role: "create", tolerate: { outcome } }),
      SECTION,
      answering(403, "Forbidden"),
      REPO,
      TOOLS,
    );
    expect(denied.status).toBe("failed");
    expect((denied as { error: unknown }).error).toBeInstanceOf(PermissionDenied);
    // The control: a tolerated operation that succeeds records its line.
    const succeeded = await executePlan(
      planOf({ role: "create", tolerate: { outcome } }),
      SECTION,
      new MockApi({}).allowMutations("POST /repos/o/r/labels"),
      REPO,
      TOOLS,
    );
    expect(succeeded).toEqual({
      status: "applied",
      changes: ["did the thing"],
      notes: [],
      landed: 1,
    });
  });

  test("an explicit tolerance naming an undeclared status is refused before any request leaves", async () => {
    // Only the erased view can spell it (the type forbids it); the executor
    // refuses against a client that would otherwise answer.
    const api = new MockApi({}, { unroutedMutations: "succeed" });
    const execution = await executePlan(
      planOf({ role: "create", tolerate: { statuses: [404], outcome: () => ({ note: "" }) } }),
      SECTION,
      api,
      REPO,
      TOOLS,
    );
    expect(execution.status).toBe("failed");
    expect(errorOf(execution)).toMatch(
      /BUG: POST \/repos\/\{owner\}\/\{repo\}\/labels was asked to tolerate status\(es\) 404, which it does not declare/,
    );
    expect(api.calls).toEqual([]);
  });

  test("a rate-limited error is never a tolerated outcome, whatever the tolerance names", async () => {
    // A rate limit can arrive as a 403; a tolerance naming 403 on an endpoint
    // that declares it still hands the error to throwFor's rate-limit branch.
    const limited = {
      ...SECTION,
      endpoints: {
        ...SECTION.endpoints,
        create: {
          route: "POST /repos/{owner}/{repo}/labels",
          statuses: { 201: "created", 403: "forbidden" },
        },
      } satisfies Record<string, EndpointDecl>,
    };
    const api = new MockApi({
      "POST /repos/o/r/labels": {
        error: { status: 403, message: "API rate limit exceeded", body: "", rateLimited: true },
      },
    });
    let consulted = false;
    const execution = await executePlan(
      planOf({
        role: "create",
        tolerate: {
          statuses: [403],
          outcome: () => {
            consulted = true;
            return { note: "" };
          },
        },
      }),
      limited,
      api,
      REPO,
      TOOLS,
    );
    expect(execution.status).toBe("failed");
    expect(errorOf(execution)).toMatch(/rate limit was hit/);
    expect(consulted).toBe(false);
  });

  test("a GraphQL operation never tolerates: only the erased view can attach one, and it is ignored", async () => {
    const api = new MockApi({
      "GRAPHQL ExecutorWrite": { error: { status: 502, message: "Bad Gateway", body: "" } },
    });
    let consulted = false;
    const execution = await executePlan(
      planOf({
        role: "write",
        variables: {},
        tolerate: {
          statuses: [502],
          outcome: () => {
            consulted = true;
            return { note: "" };
          },
        },
      }),
      SECTION,
      api,
      REPO,
      TOOLS,
    );
    expect(execution.status).toBe("failed");
    expect(errorOf(execution)).toContain("502");
    expect(consulted).toBe(false);
  });

  test("a tolerance may name only the endpoint's declared error statuses, and never on GraphQL", () => {
    // Compile-time only: each rejected shape is built first and assigned on
    // one line, so the directive anchors to the assignment whichever
    // property the compiler blames.
    type Op = PlannedOp<typeof SECTION.endpoints, typeof SECTION.graphql>;
    const outcome = () => ({ note: "" });
    const declared: Op = {
      role: "create",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [409, 422], outcome },
    };
    expect(declared.tolerate?.statuses).toEqual([409, 422]);
    const undeclared = {
      role: "create",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [404], outcome },
    } as const;
    // @ts-expect-error 404 is not a declared status of the create endpoint
    const _undeclared: Op = undeclared;
    const success = {
      role: "create",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [201], outcome },
    } as const;
    // @ts-expect-error a declared SUCCESS status is not an error to tolerate
    const _success: Op = success;
    const empty = {
      role: "create",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [], outcome },
    } as const;
    // @ts-expect-error an empty tolerance is the ordinary operation
    const _empty: Op = empty;
    const graphql = {
      role: "write",
      variables: {},
      drift: ["x"],
      change: "",
      tolerate: { outcome },
    } as const;
    // @ts-expect-error a GraphQL rejection carries no HTTP status to tolerate
    const _graphql: Op = graphql;
    // The tolerable range is the 4xx statuses minus the transport ones
    // (401, 429), checked at both boundaries.
    type Bounds = PlannedOp<{
      write: {
        route: "POST /repos/{owner}/{repo}/labels";
        statuses: {
          399: "a";
          400: "b";
          401: "c";
          429: "d";
          499: "e";
          500: "f";
          40: "g";
        };
      };
    }>;
    const edges: Bounds = {
      role: "write",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [400, 499], outcome },
    };
    expect(edges.tolerate?.statuses).toEqual([400, 499]);
    const below = {
      role: "write",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [399], outcome },
    } as const;
    // @ts-expect-error 399 is below the error range
    const _below: Bounds = below;
    const server = {
      role: "write",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [500], outcome },
    } as const;
    // @ts-expect-error a 5xx is a transport failure, never tolerable
    const _server: Bounds = server;
    const token = {
      role: "write",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [401], outcome },
    } as const;
    // @ts-expect-error 401 describes the credential, never the resource
    const _token: Bounds = token;
    const limit = {
      role: "write",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [429], outcome },
    } as const;
    // @ts-expect-error 429 is a rate limit, never tolerable
    const _limit: Bounds = limit;
    const short = {
      role: "write",
      drift: ["x"],
      change: "",
      tolerate: { statuses: [40], outcome },
    } as const;
    // @ts-expect-error 40 is not a three-digit status
    const _short: Bounds = short;
    // A change thunk returns at least one line, by type.
    const silent = { role: "write", drift: ["x"], change: () => [] as string[] } as const;
    // @ts-expect-error a change thunk cannot return a possibly-empty list
    const _silent: Bounds = silent;
  });

  test("an operation is justified by drift lines or an unverifiable facet, and by nothing less", () => {
    type Op = PlannedOp<typeof SECTION.endpoints, typeof SECTION.graphql>;
    const facet: Op = {
      role: "resend",
      params: { name: "x" },
      drift: { unverifiable: "GitHub never echoes the value back", lines: [] },
      change: "re-sent",
    };
    const both: Op = {
      role: "resend",
      params: { name: "x" },
      drift: { unverifiable: "GitHub never echoes the value back", lines: ["x drifted"] },
      change: "re-sent",
    };
    expect([driftOf(facet), driftOf(both)]).toEqual([[], ["x drifted"]]);
    expect(planCheckNotes({ ops: [facet, both], notes: ["kept"], drift: [] })).toEqual([
      "GitHub never echoes the value back",
      "GitHub never echoes the value back",
      "kept",
    ]);
    expect(planDrift({ ops: [facet, both], notes: [], drift: ["opless"] })).toEqual([
      "x drifted",
      "opless",
    ]);
    const undeclared = {
      role: "create",
      drift: { unverifiable: "why", lines: [] },
      change: "wrote",
    } as const;
    // @ts-expect-error a facet is admitted only on an endpoint declaring unverifiable
    const _undeclared: Op = undeclared;
    const empty = { role: "create", drift: [], change: "wrote" } as const;
    // @ts-expect-error empty drift without a facet is not a justification on a compare-before-write endpoint
    const _empty: Op = empty;
    const reasonless = {
      role: "resend",
      params: { name: "x" },
      drift: { lines: [] },
      change: "wrote",
    } as const;
    // @ts-expect-error a facet without its reason is not a justification
    const _reasonless: Op = reasonless;
    const lineless = {
      role: "resend",
      params: { name: "x" },
      drift: { unverifiable: "why" },
      change: "wrote",
    } as const;
    // @ts-expect-error a facet without its lines is not a justification
    const _lineless: Op = lineless;
    const graphql = {
      role: "write",
      variables: {},
      drift: { unverifiable: "why", lines: [] },
      change: "wrote",
    } as const;
    // @ts-expect-error a GraphQL mutation writes nothing it cannot read back, so it carries no facet
    const _graphql: Op = graphql;
  });

  test("a thunk receives a frozen projection holding the resolver and nothing else", async () => {
    // A caller may pass a wider object as tools; the thunk must see neither
    // that object nor anything on it beyond the resolver.
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
      expect(execution.landed).toBe(0);
      expect(errorOf(execution)).toMatch(message);
      expect(api.calls).toEqual([]);
    });
  }
});
