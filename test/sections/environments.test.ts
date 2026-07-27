import { describe, expect, test } from "bun:test";
import { environmentsSection } from "../../src/sections/environments.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

const VARIABLES_LIST = "GET /repos/o/r/environments/prod/variables?per_page=30&page=1";

/** A spec-shaped variables list body. */
function variablesBody(variables: Array<{ name: string; value: string }>) {
  return { data: { total_count: variables.length, variables } };
}

describe("environments PUT strips nested keys", () => {
  test("variables never reach the PUT body, and reconciliation runs after the PUT", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [VARIABLES_LIST]: variablesBody([
        { name: "UPD", value: "old" },
        { name: "GONE", value: "x" },
      ]),
    }).allowMutations(
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/UPD",
      "DELETE /repos/o/r/environments/prod/variables/GONE",
    );
    const declared = [
      {
        name: "prod",
        wait_timer: 5,
        variables: [
          { name: "NEW", value: "v1" },
          { name: "UPD", value: "v2" },
        ],
      },
    ];
    const result = await environmentsSection.run(ctx(api), declared);
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.payload).toEqual({ wait_timer: 5 });
    // The variables list is fetched only AFTER the environment PUT succeeded.
    const order = api.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    expect(order.indexOf("PUT /repos/o/r/environments/prod")).toBeLessThan(
      order.indexOf("GET /repos/o/r/environments/prod/variables"),
    );
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/environments/prod",
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/UPD",
      "DELETE /repos/o/r/environments/prod/variables/GONE",
    ]);
    const post = api.calls.find((c) => c.method === "POST");
    expect(post?.payload).toEqual({ name: "NEW", value: "v1" });
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ value: "v2" });
    expect(result.changes).toEqual([
      'applied environment "prod"',
      'created variable "NEW" in environment "prod"',
      'updated variable "UPD" in environment "prod"',
      'DELETED undeclared variable "GONE" from environment "prod"',
    ]);
    // The strip builds a fresh object: the caller's entry keeps its
    // variables, so the duplicate pre-pass (which reads env.variables
    // across all entries) can never observe a mutated declaration.
    expect(declared[0]?.variables).toEqual([
      { name: "NEW", value: "v1" },
      { name: "UPD", value: "v2" },
    ]);
  });

  test("an entry without a variables key leaves live variables untouched", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
    });
    const result = await environmentsSection.run(ctx(api), [{ name: "prod", wait_timer: 5 }]);
    expect(result.changes).toEqual(['applied environment "prod"']);
    // The variables endpoints are never contacted, not even the list read.
    expect(api.calls.filter((c) => c.path.includes("/variables"))).toEqual([]);
  });
});

describe("environments variables check mode", () => {
  const liveEnvironment = {
    data: { name: "prod", protection_rules: [{ id: 1, type: "wait_timer", wait_timer: 5 }] },
  };

  test("value drift and undeclared variables report drift; the environment diff excludes variables", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnvironment,
      [VARIABLES_LIST]: variablesBody([
        { name: "A", value: "2" },
        { name: "B", value: "x" },
      ]),
    });
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "prod", wait_timer: 5, variables: [{ name: "A", value: "1" }] },
    ]);
    // Exactly the nested lines: a variables key leaking into subsetDiff would
    // add an "environments[prod].variables: declared ..." line here.
    expect(result.drift).toEqual([
      'environments[prod].variables[A].value: declared "1" != live "2"; apply will set the declared value',
      "environments[prod].variables[B]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("a missing declared variable is drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnvironment,
      [VARIABLES_LIST]: variablesBody([]),
    });
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "prod", variables: [{ name: "A", value: "1" }] },
    ]);
    expect(result.drift).toEqual([
      "environments[prod].variables[A]: missing - declared in the settings file but not on the environment; apply will create it",
    ]);
  });

  test("a missing environment skips the variables read and notes it is unverifiable", async () => {
    const api = new MockApi({});
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "prod", variables: [{ name: "A", value: "1" }] },
    ]);
    expect(result.drift).toEqual([
      "environments[prod]: missing - declared in the settings file but not on the repo; apply will create it",
    ]);
    expect(result.notes).toEqual([
      "environments[prod].variables: not verifiable while the environment is missing; apply will create the environment and reconcile the declared variables",
    ]);
    expect(api.calls.filter((c) => c.path.includes("/variables"))).toEqual([]);
  });
});

describe("environments variables case-insensitive matching", () => {
  test("a case-differing live name matches and only the value is compared", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [VARIABLES_LIST]: variablesBody([{ name: "DEPLOY_REGION", value: "same" }]),
    });
    const result = await environmentsSection.run(ctx(api), [
      { name: "prod", variables: [{ name: "deploy_region", value: "same" }] },
    ]);
    // Matched despite the case difference: no create, no update, no delete.
    expect(result.changes).toEqual(['applied environment "prod"']);
  });

  test("an update addresses the PATCH at the LIVE name", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [VARIABLES_LIST]: variablesBody([{ name: "DEPLOY_REGION", value: "old" }]),
    }).allowMutations("PATCH /repos/o/r/environments/prod/variables/DEPLOY_REGION");
    await environmentsSection.run(ctx(api), [
      { name: "prod", variables: [{ name: "deploy_region", value: "new" }] },
    ]);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/repos/o/r/environments/prod/variables/DEPLOY_REGION");
    expect(patch?.payload).toEqual({ value: "new" });
  });

  test("two declared names that collapse case-insensitively are rejected before any write", async () => {
    const api = new MockApi({});
    await expect(
      environmentsSection.run(ctx(api), [
        {
          name: "prod",
          variables: [
            { name: "Region", value: "a" },
            { name: "REGION", value: "b" },
          ],
        },
      ]),
    ).rejects.toThrow(
      'environments: the "prod" entry declares variables "Region" and "REGION", which GitHub treats as the same variable (names are case-insensitive). Keep exactly one entry per variable',
    );
    // Fail-fast: nothing was written, not even the environment PUT.
    expect(api.calls).toEqual([]);
  });
});

describe("environments variables undeclared policy", () => {
  test("the wrapped undeclared:keep form keeps the live variable as a note", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [VARIABLES_LIST]: variablesBody([{ name: "LEGACY", value: "x" }]),
    });
    const result = await environmentsSection.run(ctx(api), [
      { name: "prod", variables: { undeclared: "keep", entries: [] } },
    ]);
    expect(result.notes).toEqual([
      'variable "LEGACY" exists on environment "prod" but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
    ]);
    // No DELETE was issued (the PUT is the only mutation).
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/environments/prod",
    ]);
  });

  test("the plain array form deletes undeclared variables by default", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [VARIABLES_LIST]: variablesBody([{ name: "LEGACY", value: "x" }]),
    }).allowMutations("DELETE /repos/o/r/environments/prod/variables/LEGACY");
    const result = await environmentsSection.run(ctx(api), [{ name: "prod", variables: [] }]);
    expect(result.changes).toEqual([
      'applied environment "prod"',
      'DELETED undeclared variable "LEGACY" from environment "prod"',
    ]);
  });

  test("check mode under undeclared:keep converges (note, not drift)", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": { data: { name: "prod", protection_rules: [] } },
      [VARIABLES_LIST]: variablesBody([{ name: "LEGACY", value: "x" }]),
    });
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "prod", variables: { undeclared: "keep", entries: [] } },
    ]);
    expect(result.drift).toEqual([]);
    expect(result.notes).toHaveLength(1);
  });
});

describe("environments variables shape", () => {
  test("both declared forms parse; extra entry fields pass through", () => {
    const shape = environmentsSection.shape;
    expect(
      shape.safeParse([{ name: "prod", variables: [{ name: "A", value: "1" }] }]).success,
    ).toBe(true);
    expect(
      shape.safeParse([
        {
          name: "prod",
          variables: { undeclared: "keep", entries: [{ name: "A", value: "1" }] },
        },
      ]).success,
    ).toBe(true);
    // Loose like the repository actions_variables entries: an extra field
    // rides the POST/PATCH verbatim, so a field GitHub ships tomorrow can
    // be declared the day it appears (the passthrough-first tenet).
    expect(
      shape.safeParse([{ name: "prod", variables: [{ name: "A", value: "1", future: "x" }] }])
        .success,
    ).toBe(true);
    // The WRAPPER stays strict: its keys are this action's own vocabulary.
    expect(
      shape.safeParse([{ name: "prod", variables: { entires: [], entries: [] } }]).success,
    ).toBe(false);
  });

  test("an extra entry field rides the POST and PATCH verbatim, with a phantom note", async () => {
    // The passthrough is behavioral, not just a parse rule: the field
    // reaches the wire on create AND update, and a field GitHub does not
    // echo back earns the phantom note instead of eternal silent drift.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [VARIABLES_LIST]: variablesBody([{ name: "UPD", value: "old" }]),
    }).allowMutations(
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/UPD",
    );
    const result = await environmentsSection.run(ctx(api), [
      {
        name: "prod",
        variables: [
          { name: "NEW", value: "v1", future_field: "x" },
          { name: "UPD", value: "new", future_field: "y" },
        ],
      },
    ]);
    const post = api.calls.find((c) => c.method === "POST");
    expect(post?.payload).toEqual({ name: "NEW", value: "v1", future_field: "x" });
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.payload).toEqual({ value: "new", future_field: "y" });
    // The mock echoes no future_field back, so the update notes the
    // phantom rather than pretending it converged.
    expect(result.notes.some((n) => n.includes("future_field"))).toBe(true);
  });
});
