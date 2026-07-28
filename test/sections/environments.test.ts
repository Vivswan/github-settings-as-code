import { describe, expect, test } from "bun:test";
import type { SectionContext } from "../../src/sections/contract.js";
import { environmentsSection, flattenEnvironment } from "../../src/sections/environments.js";
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

// --- Nested deployment branch policies ---------------------------------------

const POLICIES_LIST =
  "GET /repos/o/r/environments/prod/deployment-branch-policies?per_page=100&page=1";

/** A spec-shaped branch-policy list body. */
function policiesBody(policies: Array<{ id?: number; name?: string; type?: string }>) {
  return { data: { total_count: policies.length, branch_policies: policies } };
}

/** A declared entry with the flag pairing validation requires. */
function envWithPolicies(policies: unknown): Record<string, unknown> {
  return {
    name: "prod",
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    deployment_branch_policies: policies,
  };
}

describe("environments deployment branch policies apply mode", () => {
  test("creates missing, replaces a type flip (delete + recreate), deletes undeclared", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [POLICIES_LIST]: policiesBody([
        { id: 41, name: "v*", type: "branch" },
        { id: 42, name: "legacy/*", type: "branch" },
      ]),
    }).allowMutations(
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/41",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/42",
    );
    const result = await environmentsSection.run(ctx(api), [
      envWithPolicies([{ name: "release/*" }, { name: "v*", type: "tag" }]),
    ]);
    // The nested key never reaches the PUT; the singular flag object does.
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.payload).toEqual({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/environments/prod",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/41",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/42",
    ]);
    // The recreate carries the declared type; the plain create omits it (the
    // upstream default "branch" applies).
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts[0]?.payload).toEqual({ name: "release/*" });
    expect(posts[1]?.payload).toEqual({ name: "v*", type: "tag" });
    expect(result.changes).toEqual([
      'applied environment "prod"',
      'created deployment branch policy "release/*" in environment "prod"',
      'replaced deployment branch policy "v*" in environment "prod" (type is immutable; branch -> tag)',
      'DELETED undeclared deployment branch policy "legacy/*" from environment "prod"',
    ]);
  });

  test("a matching live pattern (type defaulted to branch) is a no-op", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      // The spec marks every field optional; a live policy without a type
      // reads as the upstream default "branch".
      [POLICIES_LIST]: policiesBody([{ id: 41, name: "release/*" }]),
    });
    const result = await environmentsSection.run(ctx(api), [
      envWithPolicies([{ name: "release/*" }]),
    ]);
    expect(result.changes).toEqual(['applied environment "prod"']);
  });

  test("a live policy without a name fails loudly instead of being silently skipped", async () => {
    // A nameless policy has no identity to reconcile by; dropping it would
    // let the default delete policy neither remove nor note it, and check
    // could report falsely clean. The spec marks the field optional, so the
    // extraction fails as a contract violation naming the endpoint.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [POLICIES_LIST]: policiesBody([{ id: 41, type: "branch" }]),
    });
    await expect(
      environmentsSection.run(ctx(api), [envWithPolicies([{ name: "release/*" }])]),
    ).rejects.toThrow(/returned a policy without a name/);
  });

  test("the wrapped undeclared:keep form keeps the live pattern as a note", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [POLICIES_LIST]: policiesBody([{ id: 41, name: "legacy/*", type: "branch" }]),
    });
    const result = await environmentsSection.run(ctx(api), [
      envWithPolicies({ undeclared: "keep", entries: [] }),
    ]);
    expect(result.notes.join("\n")).toContain(
      'deployment branch policy "legacy/*" exists on environment "prod" but is not declared',
    );
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/environments/prod",
    ]);
  });
});

describe("environments deployment branch policies check mode", () => {
  const liveProd = (custom: boolean) => ({
    data: {
      name: "prod",
      protection_rules: [],
      deployment_branch_policy: { protected_branches: !custom, custom_branch_policies: custom },
    },
  });

  test("missing, type-flip, and undeclared patterns report drift without writing", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProd(true),
      [POLICIES_LIST]: policiesBody([
        { id: 41, name: "v*", type: "branch" },
        { id: 42, name: "legacy/*", type: "branch" },
      ]),
    });
    const result = await environmentsSection.run(ctx(api, true), [
      envWithPolicies([{ name: "release/*" }, { name: "v*", type: "tag" }]),
    ]);
    expect(result.drift).toEqual([
      "environments[prod].deployment_branch_policies[release/*]: missing - declared in the settings file but not on the environment; apply will create it",
      "environments[prod].deployment_branch_policies[v*]: the declared type differs from the live pattern's, and a policy's type is immutable; apply will delete and recreate it",
      'environments[prod].deployment_branch_policies[v*].type: "tag" != "branch"',
      "environments[prod].deployment_branch_policies[legacy/*]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("a live environment with the flag off earns a note and never lists patterns", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProd(false),
    });
    const result = await environmentsSection.run(ctx(api, true), [
      envWithPolicies([{ name: "release/*" }]),
    ]);
    // The flag drift itself comes from the environment subsetDiff.
    expect(result.drift.join("\n")).toContain(
      "environments[prod].deployment_branch_policy.custom_branch_policies: true != false",
    );
    expect(result.notes).toContain(
      "environments[prod].deployment_branch_policies: patterns are not verifiable until custom_branch_policies is true; apply will set the flag and reconcile the declared patterns",
    );
    expect(api.calls.some((c) => c.path.includes("/deployment-branch-policies"))).toBe(false);
  });

  test("a missing environment earns the unverifiable-patterns note", async () => {
    const api = new MockApi({});
    const result = await environmentsSection.run(ctx(api, true), [
      envWithPolicies([{ name: "release/*" }]),
    ]);
    expect(result.notes).toContain(
      "environments[prod].deployment_branch_policies: not verifiable while the environment is missing; apply will create the environment and reconcile the declared patterns",
    );
    expect(api.calls.some((c) => c.path.includes("/deployment-branch-policies"))).toBe(false);
  });
});

describe("environments deployment branch policies validation and shape", () => {
  test("the flag pairing is a SHAPE rule: declaring the list without custom_branch_policies: true fails validation", () => {
    // In the shape, not the run() hook, on purpose: upfront document
    // validation rejects the document in both modes before ANY section
    // writes (the apply-mode preflight swallows non-permission hook errors,
    // so a hook check would fire only after earlier sections wrote).
    const shape = environmentsSection.shape;
    const failing: unknown[] = [
      // No sibling flag object at all.
      { name: "prod", deployment_branch_policies: [{ name: "release/*" }] },
      // The flag present but false.
      {
        name: "prod",
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
        deployment_branch_policies: [{ name: "release/*" }],
      },
      // The sibling nulled (a clear) while patterns are declared.
      {
        name: "prod",
        deployment_branch_policy: null,
        deployment_branch_policies: [{ name: "release/*" }],
      },
      // The wrapped form takes the same rule.
      { name: "prod", deployment_branch_policies: { entries: [{ name: "release/*" }] } },
    ];
    for (const entry of failing) {
      const parsed = shape.safeParse([entry]);
      expect(parsed.success).toBe(false);
      const messages = (parsed.error?.issues ?? []).map((issue) => issue.message).join("\n");
      expect(messages).toContain('the "prod" entry declares deployment_branch_policies');
      expect(messages).toContain("custom_branch_policies: true");
      // The issue points at the offending key, so the document-validation
      // error names environments[N].deployment_branch_policies.
      const paths = (parsed.error?.issues ?? []).map((issue) => issue.path.join("."));
      expect(paths).toContain("0.deployment_branch_policies");
    }
    // The paired form passes, and an entry without the plural key never
    // triggers the rule.
    expect(shape.safeParse([envWithPolicies([{ name: "release/*" }])]).success).toBe(true);
    expect(shape.safeParse([{ name: "prod", deployment_branch_policy: null }]).success).toBe(true);
  });

  test("duplicate patterns are rejected upfront, naming the environment", async () => {
    const api = new MockApi({});
    await expect(
      environmentsSection.run(ctx(api), [
        envWithPolicies([{ name: "release/*" }, { name: "release/*", type: "tag" }]),
      ]),
    ).rejects.toThrow(
      'environments: the "prod" entry declares the deployment branch policy "release/*" twice. Keep exactly one entry per pattern',
    );
    expect(api.calls).toEqual([]);
  });

  test("both declared forms parse; entries stay loose and the wrapper strict", () => {
    const shape = environmentsSection.shape;
    expect(shape.safeParse([envWithPolicies([{ name: "release/*", type: "tag" }])]).success).toBe(
      true,
    );
    expect(
      shape.safeParse([envWithPolicies({ undeclared: "keep", entries: [{ name: "v*" }] })]).success,
    ).toBe(true);
    // Loose entries: a field GitHub ships tomorrow rides the create verbatim.
    expect(shape.safeParse([envWithPolicies([{ name: "release/*", future: "x" }])]).success).toBe(
      true,
    );
    // The wrapper stays strict: its keys are this action's own vocabulary.
    expect(shape.safeParse([envWithPolicies({ entires: [], entries: [] })]).success).toBe(false);
  });
});

// --- Nested deployment protection rules --------------------------------------

const RULES_LIST = "GET /repos/o/r/environments/prod/deployment_protection_rules";
const RULE_APPS_LIST =
  "GET /repos/o/r/environments/prod/deployment_protection_rules/apps?per_page=100&page=1";
const RULE_CREATE = "POST /repos/o/r/environments/prod/deployment_protection_rules";

/** A spec-shaped enabled-rules list body. */
function rulesBody(rules: Array<Record<string, unknown>>) {
  return { data: { total_count: rules.length, custom_deployment_protection_rules: rules } };
}

/** A live enabled rule for a fixture app. */
function liveRule(id: number, slug: string): Record<string, unknown> {
  return {
    id,
    node_id: `DPR_${id}`,
    enabled: true,
    app: {
      id: id + 500,
      slug,
      integration_url: `https://api.github.com/apps/${slug}`,
      node_id: "n",
    },
  };
}

/** A spec-shaped available-Apps list body. */
function ruleAppsBody(apps: Array<{ id: number; slug: string }>) {
  return {
    data: {
      total_count: apps.length,
      available_custom_deployment_protection_rule_integrations: apps,
    },
  };
}

describe("environments deployment protection rules apply mode", () => {
  test("enables a missing rule via ONE apps fetch, keeps an undeclared one by default", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([liveRule(41, "region-guard"), liveRule(42, "change-window")]),
      [RULE_APPS_LIST]: ruleAppsBody([
        { id: 3515, slug: "deploy-gate" },
        { id: 3516, slug: "region-guard" },
      ]),
    }).allowMutations(RULE_CREATE);
    const result = await environmentsSection.run(ctx(api), [
      {
        name: "prod",
        wait_timer: 5,
        deployment_protection_rules: [{ app: "deploy-gate" }, { app: "region-guard" }],
      },
    ]);
    // The nested key never reaches the PUT body.
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.payload).toEqual({ wait_timer: 5 });
    // One create, resolved to the App's integration id; region-guard already
    // enabled, so no second POST.
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.payload).toEqual({ integration_id: 3515 });
    // The undeclared change-window rule is KEPT (the default): a note, no DELETE.
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(result.notes.join("\n")).toContain(
      'deployment protection rule "change-window" is enabled on environment "prod" but is not declared',
    );
    expect(result.changes).toEqual([
      'applied environment "prod"',
      'enabled deployment protection rule "deploy-gate" in environment "prod"',
    ]);
  });

  test("nothing missing: the apps listing is never fetched", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([liveRule(41, "deploy-gate")]),
    });
    const result = await environmentsSection.run(ctx(api), [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(api.calls.some((c) => c.path.includes("/apps"))).toBe(false);
    expect(result.changes).toEqual(['applied environment "prod"']);
  });

  test("the wrapped undeclared:delete form DISABLES a live undeclared rule by id", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([liveRule(41, "change-window")]),
    }).allowMutations("DELETE /repos/o/r/environments/prod/deployment_protection_rules/41");
    const result = await environmentsSection.run(ctx(api), [
      { name: "prod", deployment_protection_rules: { undeclared: "delete", entries: [] } },
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/environments/prod",
      "DELETE /repos/o/r/environments/prod/deployment_protection_rules/41",
    ]);
    expect(result.changes).toContain(
      'DISABLED undeclared deployment protection rule "change-window" in environment "prod"',
    );
  });

  test("a declared slug the apps listing does not carry fails loudly, naming the available slugs", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([]),
      [RULE_APPS_LIST]: ruleAppsBody([
        { id: 3515, slug: "deploy-gate" },
        { id: 3516, slug: "region-guard" },
      ]),
    });
    await expect(
      environmentsSection.run(ctx(api), [
        {
          name: "prod",
          // The resolvable deploy-gate entry comes FIRST: every missing slug
          // resolves before the first POST, so the unknown sibling aborts the
          // whole list and the environment is never half-reconciled.
          deployment_protection_rules: [{ app: "deploy-gate" }, { app: "not-installed" }],
        },
      ]),
    ).rejects.toThrow(
      'environments: the deployment protection rule App "not-installed" is not available to environment "prod" (the available Apps are "deploy-gate", "region-guard"). Install the GitHub App providing the rule on this repository, or declare one of the available slugs',
    );
    // Nothing was enabled, not even the resolvable entry.
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("an EMPTY apps listing says no Apps are available at all", async () => {
    // A real user state, not a contract break: no protection-rule App is
    // installed on the repository, so there is nothing to list in the error.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([]),
      [RULE_APPS_LIST]: ruleAppsBody([]),
    });
    await expect(
      environmentsSection.run(ctx(api), [
        { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
      ]),
    ).rejects.toThrow(
      'environments: the deployment protection rule App "deploy-gate" is not available to environment "prod" (no protection-rule Apps are available to it). Install the GitHub App providing the rule on this repository, or declare one of the available slugs',
    );
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("a live rule without an app slug fails loudly instead of being silently skipped", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([{ id: 41, node_id: "n", enabled: true, app: {} }]),
    });
    await expect(
      environmentsSection.run(ctx(api), [
        { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
      ]),
    ).rejects.toThrow(/returned a rule without an app slug/);
  });

  test("absent envelope keys read as an empty list (the spec marks both optional)", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: { data: { total_count: 0 } },
      [RULE_APPS_LIST]: ruleAppsBody([{ id: 3515, slug: "deploy-gate" }]),
    }).allowMutations(RULE_CREATE);
    const result = await environmentsSection.run(ctx(api), [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(result.changes).toContain(
      'enabled deployment protection rule "deploy-gate" in environment "prod"',
    );
  });

  test("a PRESENT non-array envelope value is a loud contract violation, never an empty list", async () => {
    // null is present-but-not-a-list too: the spec types the key as a plain
    // array, so only a genuinely ABSENT key may read as empty.
    for (const garbage of ["garbage", null]) {
      const api = new MockApi({
        "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
        [RULES_LIST]: { data: { custom_deployment_protection_rules: garbage } },
      });
      await expect(
        environmentsSection.run(ctx(api), [
          { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
        ]),
      ).rejects.toThrow(/custom_deployment_protection_rules value that is not a list/);
    }
  });

  test("a live rule with a non-numeric id fails loudly before any disable", async () => {
    // A null or string id would otherwise serialize into the DELETE path
    // (".../deployment_protection_rules/null") and address nothing.
    for (const id of [null, "41"]) {
      const api = new MockApi({
        "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
        [RULES_LIST]: rulesBody([{ ...liveRule(41, "change-window"), id }]),
      });
      await expect(
        environmentsSection.run(ctx(api), [
          { name: "prod", deployment_protection_rules: { undeclared: "delete", entries: [] } },
        ]),
      ).rejects.toThrow(/rule without a numeric id/);
      expect(api.mutations().filter((m) => m.method === "DELETE")).toEqual([]);
    }
  });
});

describe("environments deployment protection rules check mode", () => {
  test("missing declared rules are drift; undeclared ones split by policy; nothing written", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": { data: { name: "prod", protection_rules: [] } },
      [RULES_LIST]: rulesBody([liveRule(41, "change-window")]),
    });
    const kept = await environmentsSection.run(ctx(api, true), [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(kept.drift).toEqual([
      "environments[prod].deployment_protection_rules[deploy-gate]: missing - declared in the settings file but not enabled on the environment; apply will enable it",
    ]);
    expect(kept.notes.join("\n")).toContain('deployment protection rule "change-window"');
    // The apps listing is an apply-time resolver; check mode never reads it.
    expect(api.calls.some((c) => c.path.includes("/apps"))).toBe(false);
    expect(api.mutations()).toEqual([]);

    const api2 = new MockApi({
      "GET /repos/o/r/environments/prod": { data: { name: "prod", protection_rules: [] } },
      [RULES_LIST]: rulesBody([liveRule(41, "change-window")]),
    });
    const deleted = await environmentsSection.run(ctx(api2, true), [
      { name: "prod", deployment_protection_rules: { undeclared: "delete", entries: [] } },
    ]);
    expect(deleted.drift).toEqual([
      "environments[prod].deployment_protection_rules[change-window]: undeclared - not in the settings file, so apply will DISABLE it; add it to the settings file to keep it",
    ]);
  });

  test("a missing environment earns the unverifiable-rules note", async () => {
    const api = new MockApi({});
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(result.notes).toContain(
      "environments[prod].deployment_protection_rules: not verifiable while the environment is missing; apply will create the environment and reconcile the declared protection rules",
    );
    expect(api.calls.some((c) => c.path.includes("deployment_protection_rules"))).toBe(false);
  });
});

describe("environments deployment protection rules validation and shape", () => {
  test("duplicate App slugs are rejected upfront, naming the environment", async () => {
    const api = new MockApi({});
    await expect(
      environmentsSection.run(ctx(api), [
        {
          name: "prod",
          deployment_protection_rules: [{ app: "deploy-gate" }, { app: "deploy-gate" }],
        },
      ]),
    ).rejects.toThrow(
      'environments: the "prod" entry declares the deployment protection rule App "deploy-gate" twice. Keep exactly one entry per App',
    );
    expect(api.calls).toEqual([]);
  });

  test("both declared forms parse; entries are STRICT (the POST carries only the resolved id)", () => {
    const shape = environmentsSection.shape;
    expect(
      shape.safeParse([{ name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] }])
        .success,
    ).toBe(true);
    expect(
      shape.safeParse([
        {
          name: "prod",
          deployment_protection_rules: {
            undeclared: "delete",
            entries: [{ app: "deploy-gate" }],
          },
        },
      ]).success,
    ).toBe(true);
    // An extra entry key has no destination (the enable POST sends only the
    // resolved integration_id), so it is rejected rather than silently doing
    // nothing.
    expect(
      shape.safeParse([
        { name: "prod", deployment_protection_rules: [{ app: "deploy-gate", typo: 1 }] },
      ]).success,
    ).toBe(false);
    // The wrapper stays strict: its keys are this action's own vocabulary.
    expect(
      shape.safeParse([{ name: "prod", deployment_protection_rules: { entires: [], entries: [] } }])
        .success,
    ).toBe(false);
  });

  test("a custom-rule protection_rules entry flattens without leaking keys", () => {
    // The environment GET surfaces an enabled custom rule as the spec's third
    // protection_rules variant ({id, node_id, type}); flattenEnvironment's
    // generic branch filters exactly those keys, so the entry adds nothing to
    // the flattened object and can never produce false environment drift.
    const flattened = flattenEnvironment({
      name: "prod",
      protection_rules: [{ id: 41, node_id: "DPR_41", type: "deploy-gate" }],
    });
    expect(Object.keys(flattened).sort()).toEqual(["name", "protection_rules"]);
  });
});
