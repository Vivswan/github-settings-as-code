import { describe, expect, test } from "bun:test";
import type { SectionContext } from "../../../src/sections/contract.js";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  unsealSecretValue,
} from "../../../test/e2e/mock/secrets.js";
import {
  FIXTURE_ENV_NAME,
  FLAG_PAIRING_FIXTURES,
} from "../../../test/fixtures/environment-flag-pairing.js";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { environmentsSection, flattenEnvironment } from "./index.js";
import type {
  DeploymentBranchPolicyConfig,
  EnvironmentConfig,
  EnvironmentVariableConfig,
} from "./schema.js";

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
      'environments: the "prod" entry declares variables that GitHub treats as the same variable (names are case-insensitive): "Region" and "REGION". Keep exactly one entry per variable',
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
          { name: "NEW", value: "v1", future_field: "x" } as EnvironmentVariableConfig,
          { name: "UPD", value: "new", future_field: "y" } as EnvironmentVariableConfig,
        ],
      },
    ]);
    const post = api.calls.find((c) => c.method === "POST");
    expect(post?.payload).toEqual({
      name: "NEW",
      value: "v1",
      future_field: "x",
    } as EnvironmentVariableConfig);
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
    expect(result.drift?.join("\n")).toContain("environments[prod]: missing");
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
    ).rejects.toThrow(/"prod" entry declares secrets .*"token" and "TOKEN"/);
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
    // The double cast feeds secretValues a PRE-VALIDATION document slice on
    // purpose: its contract is defensiveness against any merged value.
    const values = environmentsSection.secretValues?.([
      { name: "a", secrets: [{ name: "X", value: "$X" }] },
      { name: "b", secrets: { entries: [{ name: "Y", value: "$Y" }] } },
      { name: "c" },
      { name: "d", secrets: "garbage" },
      "not-an-entry",
    ] as unknown as EnvironmentConfig[]);
    expect(values).toEqual([
      { label: 'the secret entry "X" of environment "a"', value: "$X" },
      { label: 'the secret entry "Y" of environment "b"', value: "$Y" },
    ]);
    // A non-list section value contributes nothing (validation reports it).
    expect(
      environmentsSection.secretValues?.({ not: "a list" } as unknown as EnvironmentConfig[]),
    ).toEqual([]);
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
function envWithPolicies(
  policies: EnvironmentConfig["deployment_branch_policies"],
): EnvironmentConfig {
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
    expect(result.drift?.join("\n")).toContain(
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
    // so a hook check would fire only after earlier sections wrote). The
    // fixtures are the SHARED set the published-schema test also runs, so
    // the zod refinement and the schema's if/then face the same cases.
    const shape = environmentsSection.shape;
    for (const { name, entry, valid } of FLAG_PAIRING_FIXTURES) {
      const parsed = shape.safeParse([entry]);
      expect(parsed.success, name).toBe(valid);
      if (valid) {
        continue;
      }
      const messages = (parsed.error?.issues ?? []).map((issue) => issue.message).join("\n");
      expect(messages).toContain(
        `the "${FIXTURE_ENV_NAME}" entry declares deployment_branch_policies`,
      );
      expect(messages).toContain("custom_branch_policies: true");
      // The issue points at the offending key, so the document-validation
      // error names environments[N].deployment_branch_policies.
      const paths = (parsed.error?.issues ?? []).map((issue) => issue.path.join("."));
      expect(paths).toContain("0.deployment_branch_policies");
    }
  });

  test("duplicate patterns are rejected upfront, naming the environment", async () => {
    const api = new MockApi({});
    await expect(
      environmentsSection.run(ctx(api), [
        envWithPolicies([{ name: "release/*" }, { name: "release/*", type: "tag" }]),
      ]),
    ).rejects.toThrow(
      'environments: the "prod" entry declares deployment branch policy "release/*" more than once. Keep exactly one entry per pattern',
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
    expect(
      shape.safeParse([
        envWithPolicies([{ name: "release/*", future: "x" } as DeploymentBranchPolicyConfig]),
      ]).success,
    ).toBe(true);
    // The wrapper stays strict: its keys are this action's own vocabulary.
    expect(
      shape.safeParse([
        envWithPolicies({ entires: [], entries: [] } as unknown as DeploymentBranchPolicyConfig[]),
      ]).success,
    ).toBe(false);
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
      ).rejects.toThrow(
        /returned a body outside the documented shape - custom_deployment_protection_rules/,
      );
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
      ).rejects.toThrow(
        /returned a body outside the documented shape - custom_deployment_protection_rules\[0\]\.id/,
      );
      expect(api.mutations().filter((m) => m.method === "DELETE")).toEqual([]);
    }
  });

  test("a live rule reported as disabled does not satisfy its declared gate", async () => {
    // The endpoint documents enabled rules only, so this is a belt over the
    // contract: a declared gate whose live rule says enabled: false must be
    // re-enabled, never read as clean.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([{ ...liveRule(41, "deploy-gate"), enabled: false }]),
      [RULE_APPS_LIST]: ruleAppsBody([{ id: 3515, slug: "deploy-gate" }]),
    }).allowMutations(RULE_CREATE);
    const result = await environmentsSection.run(ctx(api), [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(result.changes).toContain(
      'enabled deployment protection rule "deploy-gate" in environment "prod"',
    );
  });

  test("a disabled undeclared rule is not an active gate: neither noted nor disabled", async () => {
    // The other half of the enabled-false skip: under undeclared: delete the
    // goal is "no undeclared gate is on", which a disabled rule already
    // satisfies - and a DELETE aimed at a disabled id would likely 404
    // mid-apply for a no-op.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([{ ...liveRule(41, "change-window"), enabled: false }]),
    });
    const result = await environmentsSection.run(ctx(api), [
      { name: "prod", deployment_protection_rules: { undeclared: "delete", entries: [] } },
    ]);
    expect(api.mutations().filter((m) => m.method === "DELETE")).toEqual([]);
    expect(result.notes.join("\n")).not.toContain("change-window");
    expect(result.changes?.join("\n")).not.toContain("change-window");
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
      "environments[prod].deployment_protection_rules[deploy-gate]: missing - declared in the settings file but not enabled on the environment; apply will enable it if the App is available to this environment",
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
      'environments: the "prod" entry declares the deployment protection rule App "deploy-gate" more than once. Keep exactly one entry per App',
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

// --- Pinned environments (the routed `pinned` scalar) -------------------------

/**
 * A pins-connection body. `pins` are either names (contiguous positions
 * 1..N) or {name, position} pairs for the hole-y layouts live GitHub
 * produces after an unpin.
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

describe("environments pinned apply mode", () => {
  test("pinned never reaches the PUT body, and the pins read runs only after every PUT", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    const result = await environmentsSection.run(ctx(api), [
      { name: "prod", wait_timer: 5, pinned: true },
    ]);
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.payload).toEqual({ wait_timer: 5 });
    const order = api.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    expect(order.indexOf("PUT /repos/o/r/environments/prod")).toBeLessThan(
      order.indexOf("GRAPHQL EnvironmentPins"),
    );
    const pin = api.calls.find((c) => c.path === "PinEnvironment");
    // The mutation addresses the node id the PUT body carried.
    expect(pin?.payload).toEqual({ environmentId: "EN_prod", pinned: true });
    expect(result.changes).toEqual(['applied environment "prod"', 'pinned environment "prod"']);
  });

  test("without any pinned key the section stays REST-only", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
    });
    await environmentsSection.run(ctx(api), [{ name: "prod", wait_timer: 5 }]);
    expect(api.calls.filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("minimal mutations in cap-safe order: unpin, then pin, then leftward reorders", async () => {
    // Live [c, b]; declared order pins a then b, and c declares pinned:
    // false. The unpin runs FIRST (a swap can never transiently exceed the
    // cap), the missing a is pinned to the tail, and one reorder pulls a
    // left to position 1 - b then already sits at position 2, so no second
    // reorder is issued.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "PUT /repos/o/r/environments/b": envBody("b"),
      "PUT /repos/o/r/environments/c": envBody("c"),
      "GRAPHQL EnvironmentPins": pinsBody(["c", "b"]),
    }).allowMutations("GRAPHQL PinEnvironment", "GRAPHQL ReorderEnvironment");
    const result = await environmentsSection.run(ctx(api), [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
      { name: "c", pinned: false },
    ]);
    const graphqlWrites = api
      .mutations()
      .filter((c) => c.method === "GRAPHQL")
      .map((c) => ({ op: c.path, payload: c.payload }));
    expect(graphqlWrites).toEqual([
      { op: "PinEnvironment", payload: { environmentId: "EN_c", pinned: false } },
      { op: "PinEnvironment", payload: { environmentId: "EN_a", pinned: true } },
      { op: "ReorderEnvironment", payload: { environmentId: "EN_a", position: 1 } },
    ]);
    expect(result.changes?.slice(3)).toEqual([
      'unpinned environment "c"',
      'pinned environment "a"',
      'moved pinned environment "a" to position 1',
    ]);
  });

  test("a converged pin state issues zero pin mutations", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "PUT /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody(["a", "b"]),
    });
    await environmentsSection.run(ctx(api), [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    expect(api.mutations().filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("hole-y live positions in the right order are converged: rank, not literal numbers", async () => {
    // Verified live behavior: unpinning leaves a hole (positions 1 and 3
    // with nothing at 2), and re-pins append via a monotonic counter - so a
    // list whose RANK order matches the declaration must read converged,
    // never as position drift.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "PUT /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody([
        { name: "a", position: 1 },
        { name: "b", position: 3 },
      ]),
    });
    await environmentsSection.run(ctx(api), [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    expect(api.mutations().filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("two fresh pins land in declaration order with zero reorders (tail appends)", async () => {
    // Pins append at the tail (verified live behavior), so pinning a then b
    // onto an empty list already realizes the declared order - the plan
    // must not emit compensating reorders.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "PUT /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    await environmentsSection.run(ctx(api), [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    const writes = api
      .mutations()
      .filter((c) => c.method === "GRAPHQL")
      .map((c) => ({ op: c.path, payload: c.payload }));
    expect(writes).toEqual([
      { op: "PinEnvironment", payload: { environmentId: "EN_a", pinned: true } },
      { op: "PinEnvironment", payload: { environmentId: "EN_b", pinned: true } },
    ]);
  });

  test("live pins nobody declared count toward the cap: overflow fails BEFORE any mutation", async () => {
    // The shape's upfront cap sees only declared entries; ten live undeclared
    // pins (which the section never unpins) plus one declared pin overflow
    // GitHub's cap, and discovering that on the pin mutation would leave the
    // list half-applied. The gate throws after the read, before any write.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody([
        "u1",
        "u2",
        "u3",
        "u4",
        "u5",
        "u6",
        "u7",
        "u8",
        "u9",
        "u10",
      ]),
    });
    await expect(
      environmentsSection.run(ctx(api), [{ name: "prod", pinned: true }]),
    ).rejects.toThrow(/would leave 11 environments pinned, but GitHub allows at most 10/);
    expect(api.mutations().filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("a raced-full pinned list still surfaces GitHub's cap rejection with advice", async () => {
    // Nine live pins pass the overflow gate (9 + 1 = 10), but a pin raced in
    // between the read and the mutation makes GitHub reject with the
    // declared UNPROCESSABLE - the belt under the gate.
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody(["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9"]),
      "GRAPHQL PinEnvironment": {
        error: {
          status: 422,
          message: "Repositories may only have 10 pinned environments",
          body: "",
          graphqlTypes: ["UNPROCESSABLE"],
        },
      },
    });
    await expect(
      environmentsSection.run(ctx(api), [{ name: "prod", pinned: true }]),
    ).rejects.toThrow(/GitHub allows at most 10 pinned environments/);
  });

  test("a PUT body without a node_id fails loudly before the mutation", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      "GRAPHQL EnvironmentPins": pinsBody([]),
    });
    await expect(
      environmentsSection.run(ctx(api), [{ name: "prod", pinned: true }]),
    ).rejects.toThrow(/the environment body for "prod" carried no node_id/);
    expect(api.mutations().filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("EVERY planned mutation's id resolves before the FIRST one fires", async () => {
    // Two pins are planned and the SECOND environment's PUT body lacks its
    // node_id: resolve-before-write means the first pin must not have fired
    // when the resolution throws, or the list would be half-applied.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      "PUT /repos/o/r/environments/b": { data: { name: "b" } },
      "GRAPHQL EnvironmentPins": pinsBody([]),
    }).allowMutations("GRAPHQL PinEnvironment");
    await expect(
      environmentsSection.run(ctx(api), [
        { name: "a", pinned: true },
        { name: "b", pinned: true },
      ]),
    ).rejects.toThrow(/the environment body for "b" carried no node_id/);
    expect(api.mutations().filter((c) => c.method === "GRAPHQL")).toEqual([]);
  });

  test("a converged run never resolves ids, so a missing node_id cannot fail it", async () => {
    // The plan is empty, apply returns before id resolution: an API that
    // stopped carrying node_id must not break a repository that is already
    // in the declared state.
    const api = new MockApi({
      "PUT /repos/o/r/environments/a": { data: { name: "a" } },
      "GRAPHQL EnvironmentPins": pinsBody(["a"]),
    });
    const result = await environmentsSection.run(ctx(api), [{ name: "a", pinned: true }]);
    expect(result.changes).toEqual(['applied environment "a"']);
  });

  test("a pin node without position and name fails loudly instead of reconciling blind", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/environments/prod": envBody("prod"),
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
    await expect(
      environmentsSection.run(ctx(api), [{ name: "prod", pinned: true }]),
    ).rejects.toThrow(/returned a pin node this section cannot read/);
  });
});

describe("environments pinned check mode", () => {
  test("rank-order drift: missing pin, declared unpin, and ONE order line; nothing written", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GET /repos/o/r/environments/c": envBody("c"),
      "GET /repos/o/r/environments/d": envBody("d"),
      "GRAPHQL EnvironmentPins": pinsBody(["c", "b", "a"]),
    });
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
      { name: "c", pinned: false },
      { name: "d", pinned: true },
    ]);
    expect(result.drift).toEqual([
      "environments[d].pinned: missing - declared pinned but the environment is not pinned on the repo; apply will pin it",
      "environments[c].pinned: pinned on the repo but declared pinned: false; apply will unpin it",
      "environments.pinned: the declared pin order is [a, b, d] but the live pinned order is [c, b, a]; apply will reorder the pins so the declared ones lead in declaration order",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("clean when the declared pins lead in declaration order; trailing undeclared pins earn nothing", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody(["a", "b", "legacy"]),
    });
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    // Also the diff-leak pin: a routed `pinned` reaching subsetDiff would
    // add an "environments[a].pinned: declared true ..." line here.
    expect(result.drift).toEqual([]);
    // legacy sits AFTER the declared block, so apply would not move it: no
    // interleaving note, check and apply agree exactly.
    expect(result.notes).toEqual([]);
  });

  test("hole-y live positions in rank order read clean, never as order drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      "GET /repos/o/r/environments/b": envBody("b"),
      "GRAPHQL EnvironmentPins": pinsBody([
        { name: "a", position: 2 },
        { name: "b", position: 5 },
      ]),
    });
    const result = await environmentsSection.run(ctx(api, true), [
      { name: "a", pinned: true },
      { name: "b", pinned: true },
    ]);
    expect(result.drift).toEqual([]);
  });

  test("the live-cap overflow surfaces as a note in check mode (apply hard-fails there)", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": pinsBody([
        "u1",
        "u2",
        "u3",
        "u4",
        "u5",
        "u6",
        "u7",
        "u8",
        "u9",
        "u10",
      ]),
    });
    const result = await environmentsSection.run(ctx(api, true), [{ name: "prod", pinned: true }]);
    expect(result.drift?.join("\n")).toContain("environments[prod].pinned: missing");
    expect(result.notes.join("\n")).toContain(
      "apply will fail: pinning the 1 declared environment(s) not yet pinned would leave 11 environments pinned",
    );
  });

  test("an undeclared pin among the declared ranks earns the interleaving note in both modes", async () => {
    const liveRoutes = {
      "GRAPHQL EnvironmentPins": pinsBody(["legacy", "a"]),
    };
    const checkApi = new MockApi({
      "GET /repos/o/r/environments/a": envBody("a"),
      ...liveRoutes,
    });
    const checked = await environmentsSection.run(ctx(checkApi, true), [
      { name: "a", pinned: true },
    ]);
    const note =
      'pinned environment(s) "legacy" have no pinned declaration in the settings file; they stay pinned (only a pinned: false entry unpins) and apply moves them after the declared pins';
    expect(checked.notes).toEqual([note]);
    const applyApi = new MockApi({
      "PUT /repos/o/r/environments/a": envBody("a"),
      ...liveRoutes,
    }).allowMutations("GRAPHQL ReorderEnvironment");
    const applied = await environmentsSection.run(ctx(applyApi), [{ name: "a", pinned: true }]);
    expect(applied.notes).toEqual(checked.notes);
    // Apply moves a left to rank 1; legacy is never unpinned.
    const writes = applyApi.mutations().filter((c) => c.method === "GRAPHQL");
    expect(writes.map((c) => c.path)).toEqual(["ReorderEnvironment"]);
  });

  test("names match case-insensitively, like the section's natural key", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("PROD"),
      "GRAPHQL EnvironmentPins": pinsBody(["PROD"]),
    });
    const result = await environmentsSection.run(ctx(api, true), [{ name: "prod", pinned: true }]);
    expect(result.drift).toEqual([]);
  });

  test("a tolerated NOT_FOUND on the pins read reads as no pins, never a permission error", async () => {
    // The fine-grained-denial disguise: GraphQL conceals a denied repository
    // as NOT_FOUND, which the pins read declares as an outcome - the same
    // absent posture as the section's REST probe, so check reports drift
    // and the denial surfaces on the first write in apply mode.
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": envBody("prod"),
      "GRAPHQL EnvironmentPins": {
        error: { status: 404, message: "Not Found", body: "", graphqlTypes: ["NOT_FOUND"] },
      },
    });
    const result = await environmentsSection.run(ctx(api, true), [{ name: "prod", pinned: true }]);
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

  test("more than 10 pinned entries are rejected upfront, naming GitHub's cap", () => {
    const shape = environmentsSection.shape;
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ name: `env-${i}`, pinned: true }));
    expect(shape.safeParse(entries(10)).success).toBe(true);
    const rejected = shape.safeParse(entries(11));
    expect(rejected.success).toBe(false);
    const issue = rejected.error?.issues[0];
    expect(issue?.message).toContain("GitHub allows at most 10 pinned environments per repository");
    // The issue points at the first entry OVER the cap.
    expect(issue?.path).toEqual([10, "pinned"]);
  });
});
