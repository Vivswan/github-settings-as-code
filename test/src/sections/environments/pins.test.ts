import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../../src/engine/execute.js";
import type { SectionFailure } from "../../../../src/sections/contract/errors.js";
import { driftOf, planDrift } from "../../../../src/sections/contract/plan.js";
import { environmentsSection } from "../../../../src/sections/environments/index.js";
import { MAX_PINNED_ENVIRONMENTS } from "../../../../src/sections/environments/schema.js";
import { MockApi } from "../../../mock-api.js";
import { NO_SECRETS, REPO, sectionRunners } from "../../../sections/section-run.js";

const { plan, check, apply } = sectionRunners(environmentsSection);

/**
 * A pins-connection body; `pins` are names at contiguous positions 1..N, or {name, position} pairs for the hole-y layouts live GitHub produces after
 * an unpin.
 */
function pinsBody(pins: Array<string | { name: string; position: number }>) {
  return {
    data: {
      repository: {
        pinnedEnvironments: {
          nodes: pins.map((pin, index) =>
            typeof pin === "string"
              ? { position: index + 1, environment: { name: pin } }
              : { position: pin.position, environment: { name: pin.name } },
          ),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

/** A PUT/GET environment body carrying the node id the pin mutations address. */
function envBody(name: string) {
  return { data: { name, protection_rules: [], node_id: `EN_${name}` } };
}

/** The GraphQL writes a fake recorded, as {op, payload} pairs. */
function graphqlWrites(api: MockApi) {
  return api
    .mutations()
    .filter((c) => c.method === "GRAPHQL")
    .map((c) => ({ op: c.path, payload: c.payload }));
}

describe("environments pinned apply mode", () => {
  test("pinned never reaches the PUT body, and a created environment's pin addresses the node id its PUT answered with", async () => {
    // The environment does not exist yet, so its node id is known only once the PUT has run: the PUT's capture hands it to the pin mutation.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    const result = await apply(api, [{ name: "prod", wait_timer: 5, pinned: true }]);
    expect(api.calls.find((c) => c.method === "PUT")?.payload).toEqual({ wait_timer: 5 });
    const order = api.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("PUT /repos/o/r/environments/prod")).toBeLessThan(
      order.indexOf("GRAPHQL PinEnvironment"),
    );
    expect(graphqlWrites(api)).toEqual([
      { op: "PinEnvironment", payload: { environmentId: "EN_prod", pinned: true } },
    ]);
    expect(result.changes).toEqual(['applied environment "prod"', 'pinned environment "prod"']);
  });

  test("an existing environment's pin addresses the node id the probe body carried", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    const result = await apply(api, [{ name: "prod", pinned: true }]);
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual(["GRAPHQL PinEnvironment"]);
    expect(graphqlWrites(api)[0]?.payload).toEqual({ environmentId: "EN_prod", pinned: true });
    expect(result.changes).toEqual(['pinned environment "prod"']);
  });

  test("without any pinned key the section stays REST-only", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
    });
    await apply(api, [{ name: "prod", wait_timer: 5 }]);
    expect(api.calls.filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("minimal mutations in cap-safe order: unpin, then pin, then leftward reorders", async () => {
    // Live [c, b]; declared pins a then b, c pinned: false. The unpin runs first (a swap can never transiently exceed the cap); after a is pinned to
    // the tail, one reorder pulls it to 1 and b already sits at 2.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GET /repos/o/r/environments/c": envBody("c"),
      "GRAPHQL EnvironmentPins": pinsBody(["c", "b"]),
    }).allowMutations("GRAPHQL PinEnvironment", "GRAPHQL ReorderEnvironment");
    const result = await apply(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
      { name: "c", pinned: false },
    ]);
    expect(graphqlWrites(api)).toEqual([
      { op: "PinEnvironment", payload: { environmentId: "EN_c", pinned: false } },
      { op: "PinEnvironment", payload: { environmentId: "EN_a", pinned: true } },
      { op: "ReorderEnvironment", payload: { environmentId: "EN_a", position: 1 } },
    ]);
    expect(result.changes).toEqual([
      'applied environment "a"',
      'unpinned environment "c"',
      'pinned environment "a"',
      'moved pinned environment "a" to position 1',
    ]);
  });

  test.each([
    ["contiguous positions in declaration order", ["a", "b"]],
    // GitHub leaves a hole when it unpins (positions 1 and 3, nothing at 2) and appends re-pins via a monotonic counter, so rank order, not the
    // literal numbers, is what converges.
    [
      "hole-y positions in declaration order",
      [
        { name: "a", position: 1 },
        { name: "b", position: 3 },
      ],
    ],
    [
      "hole-y positions starting past 1",
      [
        { name: "a", position: 2 },
        { name: "b", position: 5 },
      ],
    ],
    ["the declared pins leading, an undeclared pin trailing", ["a", "b", "legacy"]],
  ] as Array<[string, Array<string | { name: string; position: number }>]>)(
    "a converged pin state plans nothing, by rank not position (%s): no mutation, no drift, no note",
    async (_what, live) => {
      const api = new MockApi({
        "GET /repos/o/r/environments/a": envBody("a"),
        "GET /repos/o/r/environments/b": envBody("b"),
        "GRAPHQL EnvironmentPins": pinsBody(live),
      });
      const planned = await plan(api, [
        { name: "a", pinned: true },
        { name: "b", pinned: true },
      ]);
      // A routed `pinned` reaching subsetDiff would add an "environments[a].pinned: declared true ..." drift line here.
      expect(planned).toEqual({ ops: [], notes: [], drift: [] });
    },
  );

  test("two fresh pins land in declaration order with zero reorders (tail appends)", async () => {
    // Pins append at the tail (verified live), so pinning a then b onto an empty list already realizes the declared order.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "PUT /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    await apply(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    expect(graphqlWrites(api)).toEqual([
      { op: "PinEnvironment", payload: { environmentId: "EN_a", pinned: true } },
      { op: "PinEnvironment", payload: { environmentId: "EN_b", pinned: true } },
    ]);
  });

  test.each([
    [
      "one declared pin over the cap",
      MAX_PINNED_ENVIRONMENTS,
      ["prod"],
      // u1 also earns the interleaving note: it leads the list the declared pin should lead.
      [
        'pinned environment "u1" has no pinned declaration in the settings file; it stays pinned (only a pinned: false entry unpins) and apply moves it after the declared pins',
        `apply will fail: pinning the 1 declared environment not yet pinned would leave ${MAX_PINNED_ENVIRONMENTS + 1} ` +
          `environments pinned, but GitHub allows at most ${MAX_PINNED_ENVIRONMENTS}. Pins without a pinned declaration ` +
          "are left untouched, so declare pinned: false on entries for some of the currently " +
          "pinned environments, or unpin them in the GitHub UI",
      ],
    ],
    [
      "two declared pins over the cap, counted in the plural",
      MAX_PINNED_ENVIRONMENTS - 1,
      ["prod", "stage"],
      [
        'pinned environments "u1", "u2" have no pinned declaration in the settings file; they stay pinned (only a pinned: false entry unpins) and apply moves them after the declared pins',
        `apply will fail: pinning the 2 declared environments not yet pinned would leave ${MAX_PINNED_ENVIRONMENTS + 1} ` +
          `environments pinned, but GitHub allows at most ${MAX_PINNED_ENVIRONMENTS}. Pins without a pinned declaration ` +
          "are left untouched, so declare pinned: false on entries for some of the currently " +
          "pinned environments, or unpin them in the GitHub UI",
      ],
    ],
  ])(
    "live pins nobody declared count toward the cap (%s): overflow fails BEFORE any mutation",
    async (_what, liveCount, declared, notes) => {
      // The shape's upfront cap sees only declared entries; live undeclared pins (never unpinned) plus the declared ones overflow GitHub's cap, so
      // the first pin thunk refuses before its request leaves, after the environment PUTs landed.
      const api = new MockApi({
        ...Object.fromEntries(
          declared.map((name) => [`PUT /repos/o/r/environments/${name}`, envBody(name)]),
        ),
        "GRAPHQL EnvironmentPins": pinsBody(
          Array.from({ length: liveCount }, (_, index) => `u${index + 1}`),
        ),
      }).allowMutations("GRAPHQL PinEnvironment");
      const planned = await plan(
        api,
        declared.map((name) => ({ name, pinned: true })),
      );
      expect(planned.notes).toEqual(notes);
      const execution = await executePlan(planned, environmentsSection, api, REPO, NO_SECRETS);
      expect(execution.status).toBe("failed");
      expect(execution.changes).toEqual(declared.map((name) => `applied environment "${name}"`));
      expect((execution as { failure: SectionFailure }).failure.message).toMatch(
        new RegExp(
          `would leave ${MAX_PINNED_ENVIRONMENTS + 1} environments pinned, but GitHub allows at most ${MAX_PINNED_ENVIRONMENTS}`,
        ),
      );
      expect(api.mutations().filter((c) => c.method === "GRAPHQL")).toEqual([]);
    },
  );

  test("a raced-full pinned list surfaces GitHub's cap rejection on the pin mutation", async () => {
    // One live pin short of the cap passes the overflow gate; a pin raced in between the read and the mutation makes GitHub reject with
    // UNPROCESSABLE, the belt under the gate.
    const capMessage = `Repositories may only have ${MAX_PINNED_ENVIRONMENTS} pinned environments`;
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody(
        Array.from({ length: MAX_PINNED_ENVIRONMENTS - 1 }, (_, index) => `u${index + 1}`),
      ),
      "GRAPHQL PinEnvironment": {
        error: {
          status: 422,
          message: capMessage,
          body: "",
          graphqlTypes: ["UNPROCESSABLE"],
        },
      },
    });
    await expect(apply(api, [{ name: "prod", pinned: true }])).rejects.toThrow(
      `environments: pinning environment "prod" failed - GRAPHQL PinEnvironment: 422 ${capMessage}`,
    );
  });

  test("a PUT response without a node_id fails that operation, records no line, and fires no pin", async () => {
    // The capture extracts the id synchronously as the PUT lands, so the failure is the PUT's own (no change line) and the pin never runs.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    const planned = await plan(api, [{ name: "prod", pinned: true }]);
    expect(planned.ops.map((op) => op.role)).toEqual(["update", "pin"]);
    const execution = await executePlan(planned, environmentsSection, api, REPO, NO_SECRETS);
    expect(execution.status).toBe("failed");
    expect(execution.changes).toEqual([]);
    expect((execution as { failure: SectionFailure }).failure.message).toMatch(
      /the environment body for "prod" carried no node_id/,
    );
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /repos/o/r/environments/prod",
    ]);
  });

  test("EVERY planned mutation's id resolves before the FIRST one fires", async () => {
    // The SECOND environment's PUT body lacks its node_id: resolve-before-write means the first pin must not have fired when the resolution throws.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "PUT /repos/o/r/environments/b": { data: { name: "b" } },
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    await expect(
      apply(api, [
        { name: "a", pinned: true },
        { name: "b", pinned: true },
      ]),
    ).rejects.toThrow(/the environment body for "b" carried no node_id/);
    expect(api.mutations().filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("a converged run never resolves ids, so a missing node_id cannot fail it", async () => {
    // No pin mutation is planned, so no thunk resolves an id: an API that stopped carrying node_id must not break a converged repository.
    const api = new MockApi({
      "GET /repos/o/r/environments/a": { data: { name: "a", protection_rules: [] } },
      "GRAPHQL EnvironmentPins": pinsBody(["a"]),
    });
    const result = await apply(api, [{ name: "a", pinned: true }]);
    expect(result.changes).toEqual([]);
  });

  test("a pin node without position and name fails loudly instead of reconciling blind", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": {
        data: {
          repository: {
            pinnedEnvironments: {
              nodes: [{ environment: { name: "prod" } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
    await expect(plan(api, [{ name: "prod", pinned: true }])).rejects.toThrow(
      "environments: GRAPHQL EnvironmentPins returned a body outside the documented shape - [0].position: Invalid input: expected number, received undefined",
    );
  });
});

describe("environments pinned check mode", () => {
  test("rank-order drift in wire order: the unpin, the missing pin, then ONE order line; nothing written", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GET /repos/o/r/environments/c": envBody("c"),
      "GET /repos/o/r/environments/d": envBody("d"),
      "GRAPHQL EnvironmentPins": pinsBody(["c", "b", "a"]),
    });
    const result = await check(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
      { name: "c", pinned: false },
      { name: "d", pinned: true },
    ]);
    expect(result.drift).toEqual([
      "environments[c].pinned: pinned on the repo but declared pinned: false; apply will unpin it",
      "environments[d].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it",
      "environments.pinned: the declared pin order is [a, b, d] but the live pinned order is [c, b, a]; apply will reorder the pins so the declared ones lead in declaration order",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("every reorder after the first is a continuation of the one order line, never per-environment pin drift", async () => {
    // After a moves to 1, c has slid right, so b still needs its own move to 2.
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GET /repos/o/r/environments/c": envBody("c"),
      "GRAPHQL EnvironmentPins": pinsBody(["c", "b", "a"]),
    });
    const planned = await plan(api, [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
      { name: "c", pinned: true },
    ]);
    expect(planned.ops.map((op) => [op.role, op.change, ...driftOf(op)])).toEqual([
      [
        "reorder",
        'moved pinned environment "a" to position 1',
        "environments.pinned: the declared pin order is [a, b, c] but the live pinned order is [c, b, a]; apply will reorder the pins so the declared ones lead in declaration order",
      ],
      [
        "reorder",
        'moved pinned environment "b" to position 2',
        'environments.pinned: apply will also move "b" to position 2 in that reordering',
      ],
    ]);
    expect(planDrift(planned)).toEqual([
      "environments.pinned: the declared pin order is [a, b, c] but the live pinned order is [c, b, a]; apply will reorder the pins so the declared ones lead in declaration order",
      'environments.pinned: apply will also move "b" to position 2 in that reordering',
    ]);
  });

  test.each([
    [
      "one undeclared pin ahead of one declared pin reads in the singular",
      ["legacy", "a"],
      ["a"],
      'pinned environment "legacy" has no pinned declaration in the settings file; it stays pinned (only a pinned: false entry unpins) and apply moves it after the declared pins',
      ["ReorderEnvironment"],
    ],
    [
      "two undeclared pins ahead of two declared pins read in the plural",
      ["legacy", "older", "a", "b"],
      ["a", "b"],
      'pinned environments "legacy", "older" have no pinned declaration in the settings file; they stay pinned (only a pinned: false entry unpins) and apply moves them after the declared pins',
      ["ReorderEnvironment", "ReorderEnvironment"],
    ],
  ])(
    "an undeclared pin among the declared ranks earns the interleaving note in both modes, agreeing in number: %s",
    async (_what, live, declaredNames, note, reorders) => {
      const api = new MockApi({
        "GET /repos/o/r/environments/a": envBody("a"),
        "GET /repos/o/r/environments/b": envBody("b"),
        "GRAPHQL EnvironmentPins": pinsBody(live),
      }).allowMutations("GRAPHQL ReorderEnvironment");
      const declared = declaredNames.map((name) => ({ name, pinned: true }));
      const checked = await check(api, declared);
      expect(checked.notes).toEqual([note]);
      const applied = await apply(api, declared);
      expect(applied.notes).toEqual(checked.notes);
      // Apply moves each declared pin left to its rank; the undeclared ones are never unpinned.
      expect(graphqlWrites(api).map((c) => c.op)).toEqual(reorders);
    },
  );

  test("names match case-insensitively, like the section's natural key", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("PROD"),
      "GRAPHQL EnvironmentPins": pinsBody(["PROD"]),
    });
    const result = await check(api, [{ name: "prod", pinned: true }]);
    expect(result.drift).toEqual([]);
  });

  test("a tolerated NOT_FOUND on the pins read reads as no pins, never a permission error", async () => {
    // GraphQL conceals a denied repository as NOT_FOUND, which the pins read declares as an outcome (the same absent posture as the REST probe), so
    // check reports drift and the denial surfaces on the first write in apply mode.
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": {
        error: { status: 404, message: "Not Found", body: "", graphqlTypes: ["NOT_FOUND"] },
      },
    });
    const result = await check(api, [{ name: "prod", pinned: true }]);
    expect(result.drift).toEqual([
      "environments[prod].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it",
    ]);
  });
});

describe("environments pinned shape", () => {
  test("pinned parses as an optional boolean and rejects non-booleans", () => {
    const shape = environmentsSection.shape;
    expect(shape.safeParse([{ name: "prod", pinned: true }]).success).toBe(true);
    expect(shape.safeParse([{ name: "prod", pinned: false }]).success).toBe(true);
    expect(shape.safeParse([{ name: "prod" }]).success).toBe(true);
    expect(shape.safeParse([{ name: "prod", pinned: "yes" }]).success).toBe(false);
  });

  test("more pinned entries than GitHub's cap are rejected upfront, naming the cap", () => {
    const shape = environmentsSection.shape;
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ name: `env-${i}`, pinned: true }));
    expect(shape.safeParse(entries(MAX_PINNED_ENVIRONMENTS)).success).toBe(true);
    const rejected = shape.safeParse(entries(MAX_PINNED_ENVIRONMENTS + 1));
    expect(rejected.success).toBe(false);
    const issue = rejected.error?.issues[0];
    expect(issue?.message).toContain(
      `GitHub allows at most ${MAX_PINNED_ENVIRONMENTS} pinned environments per repository`,
    );
    // The issue points at the first entry OVER the cap.
    expect(issue?.path).toEqual([MAX_PINNED_ENVIRONMENTS, "pinned"]);
  });
});
