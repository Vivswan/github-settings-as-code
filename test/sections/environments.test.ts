import { describe, expect, test } from "bun:test";
import type { SectionContext } from "../../src/sections/contract.js";
import { environmentsSection } from "../../src/sections/environments.js";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  unsealSecretValue,
} from "../e2e/mock/secrets.js";
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

// --- Nested per-environment secrets -----------------------------------------

const STAGING_SECRETS_LIST = "GET /repos/o/r/environments/staging/secrets?per_page=100&page=1";
const PROD_SECRETS_LIST = "GET /repos/o/r/environments/prod/secrets?per_page=100&page=1";
const STAGING_KEY = "GET /repos/o/r/environments/staging/secrets/public-key";
const PROD_KEY = "GET /repos/o/r/environments/prod/secrets/public-key";

/** A spec-shaped environment secrets list body (names + timestamps only). */
function secretsBody(names: string[]) {
  return {
    data: {
      total_count: names.length,
      secrets: names.map((name) => ({
        name,
        created_at: "2020-01-15T00:00:00Z",
        updated_at: "2020-01-15T00:00:00Z",
      })),
    },
  };
}

/** A SectionContext with a resolver, like the engine provides in apply mode. */
function secretCtx(api: MockApi, resolved: Record<string, string>): SectionContext {
  return {
    ...ctx(api),
    resolveSecret: (reference: string): string => {
      const plaintext = resolved[reference];
      if (plaintext === undefined) {
        throw new Error(`test resolver has no value for ${reference}`);
      }
      return plaintext;
    },
  };
}

describe("environments nested secrets apply mode", () => {
  test("same-named secrets in sibling environments seal each environment's OWN value", async () => {
    // The regression this pins: prepareSecretValues keys its lookup by
    // secret name alone, so it must run PER ENVIRONMENT - one global call
    // would collide DEPLOY_TOKEN across the two scopes and seal one value
    // into both.
    await mockSodiumReady();
    const api = new MockApi({
      "PUT /repos/o/r/environments/staging": { data: { name: "staging" } },
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [STAGING_SECRETS_LIST]: secretsBody([]),
      [PROD_SECRETS_LIST]: secretsBody(["DEPLOY_TOKEN"]),
      [STAGING_KEY]: { data: { key_id: "k-stg", key: MOCK_SECRETS_PUBLIC_KEY } },
      [PROD_KEY]: { data: { key_id: "k-prod", key: MOCK_SECRETS_PUBLIC_KEY } },
    }).allowMutations(
      "PUT /repos/o/r/environments/staging/secrets/DEPLOY_TOKEN",
      "PUT /repos/o/r/environments/prod/secrets/DEPLOY_TOKEN",
    );
    const result = await environmentsSection.run(
      secretCtx(api, { $STG: "staging-plaintext", $PRD: "prod-plaintext" }),
      [
        { name: "staging", secrets: [{ name: "DEPLOY_TOKEN", value: "$STG" }] },
        { name: "prod", secrets: [{ name: "DEPLOY_TOKEN", value: "$PRD" }] },
      ],
    );
    const puts = api.mutations().filter((c) => c.method === "PUT" && c.path.includes("/secrets/"));
    expect(puts.map((c) => c.path)).toEqual([
      "/repos/o/r/environments/staging/secrets/DEPLOY_TOKEN",
      "/repos/o/r/environments/prod/secrets/DEPLOY_TOKEN",
    ]);
    const unsealed = puts.map((c) =>
      unsealSecretValue((c.payload as { encrypted_value: string }).encrypted_value),
    );
    expect(unsealed).toEqual(["staging-plaintext", "prod-plaintext"]);
    // Each scope sealed against ITS environment's key_id.
    expect(puts.map((c) => (c.payload as { key_id: string }).key_id)).toEqual(["k-stg", "k-prod"]);
    // Change lines place every write in its environment (verb from the
    // per-environment listing: staging creates, prod updates).
    expect(result.changes).toEqual([
      'applied environment "staging"',
      'created secret "DEPLOY_TOKEN" in environment "staging"',
      'applied environment "prod"',
      'updated secret "DEPLOY_TOKEN" in environment "prod"',
    ]);
  });

  test("the secrets key never reaches the environment PUT body", async () => {
    await mockSodiumReady();
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [PROD_SECRETS_LIST]: secretsBody([]),
      [PROD_KEY]: { data: { key_id: "k", key: MOCK_SECRETS_PUBLIC_KEY } },
    }).allowMutations("PUT /repos/o/r/environments/prod/secrets/S");
    await environmentsSection.run(secretCtx(api, { $S: "v" }), [
      { name: "prod", wait_timer: 5, secrets: [{ name: "S", value: "$S" }] },
    ]);
    const envPut = api.calls.find((c) => c.method === "PUT" && !c.path.includes("/secrets/"));
    expect(envPut?.payload).toEqual({ wait_timer: 5 });
  });

  test("undeclared live secrets: kept with a note by default, DELETED under the knob", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [PROD_SECRETS_LIST]: secretsBody(["LEGACY"]),
    });
    const kept = await environmentsSection.run(ctx(api), [{ name: "prod", secrets: [] }]);
    expect(kept.notes.join("\n")).toContain(
      'prod environment secret "LEGACY" exists on the environment but is not declared',
    );
    expect(api.calls.filter((c) => c.path.includes("/secrets/"))).toEqual([]);

    const api2 = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [PROD_SECRETS_LIST]: secretsBody(["LEGACY"]),
    }).allowMutations("DELETE /repos/o/r/environments/prod/secrets/LEGACY");
    const deleted = await environmentsSection.run(ctx(api2), [
      { name: "prod", secrets: { undeclared: "delete", entries: [] } },
    ]);
    expect(deleted.changes).toContain('DELETED undeclared secret "LEGACY" in environment "prod"');
    // Nothing declared, so no resolver was needed and no public key fetched.
    expect(api2.calls.some((c) => c.path.endsWith("/public-key"))).toBe(false);
  });
});

describe("environments nested secrets check mode", () => {
  const liveProd = {
    data: { name: "prod", protection_rules: [] },
  };

  test("declared-but-missing is drift with the per-environment label; the note names the environment", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProd,
      [PROD_SECRETS_LIST]: secretsBody(["LEGACY"]),
    });
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "prod", secrets: [{ name: "DEPLOY_TOKEN", value: "$D" }] },
    ]);
    expect(result.drift).toEqual([
      "environments[prod].secrets[DEPLOY_TOKEN]: missing - declared in the settings file but not on the environment; apply will create it",
    ]);
    const cannotVerify = result.notes.filter((n) => n.includes("cannot be read back"));
    expect(cannotVerify).toHaveLength(1);
    expect(cannotVerify[0]).toContain("prod environment secret values");
    expect(api.mutations()).toEqual([]);
    // Check mode never touches the sealing key.
    expect(api.calls.some((c) => c.path.endsWith("/public-key"))).toBe(false);
  });

  test("a missing environment earns the unverifiable-secrets note, like variables", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": {
        error: { status: 404, message: "Not Found", body: "" },
      },
    });
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "prod", secrets: [{ name: "S", value: "$S" }] },
    ]);
    expect(result.drift.join("\n")).toContain("environments[prod]: missing");
    expect(result.notes.join("\n")).toContain(
      "environments[prod].secrets: not verifiable while the environment is missing",
    );
    // The secrets list of a missing environment is never requested.
    expect(api.calls.some((c) => c.path.includes("/secrets"))).toBe(false);
  });
});

describe("environments nested secrets validation and shape", () => {
  test("case-insensitive duplicate names are rejected upfront, naming the environment", async () => {
    const api = new MockApi({});
    await expect(
      environmentsSection.run(ctx(api), [
        {
          name: "prod",
          secrets: [
            { name: "token", value: "$A" },
            { name: "TOKEN", value: "$B" },
          ],
        },
      ]),
    ).rejects.toThrow(/"prod" entry declares secrets "token" and "TOKEN"/);
    expect(api.calls).toEqual([]);
  });

  test("secret entries are strict; the singular entry-level `secret` key is rejected by name", () => {
    const shape = environmentsSection.shape;
    expect(shape.safeParse([{ name: "prod", secrets: [{ name: "A", value: "$A" }] }]).success).toBe(
      true,
    );
    expect(
      shape.safeParse([
        { name: "prod", secrets: { undeclared: "delete", entries: [{ name: "A", value: "$A" }] } },
      ]).success,
    ).toBe(true);
    // An extra entry key has no destination (the PUT body is the sealed
    // value alone), so it is rejected rather than silently doing nothing.
    expect(
      shape.safeParse([{ name: "prod", secrets: [{ name: "A", value: "$A", typo: 1 }] }]).success,
    ).toBe(false);
    // The misplacement pin: a singular `secret` would ride the environment
    // PUT verbatim and configure nothing.
    const misplaced = shape.safeParse([{ name: "prod", secret: [{ name: "A", value: "$A" }] }]);
    expect(misplaced.success).toBe(false);
    expect(JSON.stringify(misplaced.error?.issues)).toContain(
      "belong under the entry's `secrets` list",
    );
  });

  test("secretValues walks every entry's secrets list and survives malformed containers", () => {
    const values = environmentsSection.secretValues?.([
      { name: "a", secrets: [{ name: "X", value: "$X" }] },
      { name: "b", secrets: { entries: [{ name: "Y", value: "$Y" }] } },
      { name: "c" },
      { name: "d", secrets: "garbage" },
      "not-an-entry",
    ]);
    expect(values).toEqual(["$X", "$Y"]);
    // A non-list section value contributes nothing (validation reports it).
    expect(environmentsSection.secretValues?.({ not: "a list" })).toEqual([]);
  });
});
