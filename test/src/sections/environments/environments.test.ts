import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../../src/engine/execute.js";
import type { GitHubClient } from "../../../../src/github/api.js";
import { planDrift, snapshotContext } from "../../../../src/sections/contract/plan.js";
import {
  environmentsSection,
  flattenEnvironment,
} from "../../../../src/sections/environments/index.js";
import {
  EnvironmentConfig,
  type EnvironmentVariableConfig,
} from "../../../../src/sections/environments/schema.js";
import { sharedSecretNotes, withPins } from "../../../../src/sections/environments/snapshot.js";
import { projectOntoSchema } from "../../../../src/sections/shared/snapshot-helpers.js";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  unsealSecretValue,
} from "../../../e2e/mock/secrets.js";
import { ENVIRONMENT_PARSE_FIXTURES } from "../../../fixtures/environment-parse-rules.js";
import { MockApi, type Route } from "../../../mock-api.js";
import { fragmentFake, registryFake } from "../../../sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../sections/plan-idempotence.js";
import {
  failureOf,
  NO_SECRETS,
  REPO,
  secretTools,
  sectionRunners,
  unwrap,
} from "../../../sections/section-run.js";
import { proveSnapshotRoundTrip } from "../../../sections/snapshot-roundtrip.js";
import { environmentsMockHandlers } from "./mock.js";

const { plan, check, apply } = sectionRunners(environmentsSection);

/** What a check run reports and an apply run does, side by side, for the tables that pin both modes at once. */
type Outcome = {
  drift: string[];
  notes: string[];
  changes: readonly string[];
  mutations: string[];
};

/** A live environment body with no protection rules (the converged base). */
function liveEnv(name: string, extra: Record<string, unknown> = {}) {
  return { data: { name, protection_rules: [], ...extra } };
}

const VARIABLES_LIST = "GET /repos/o/r/environments/prod/variables?per_page=30&page=1";

/** A spec-shaped variables list body. */
function variablesBody(variables: Array<{ name: string; value: string }>) {
  return { data: { total_count: variables.length, variables } };
}

describe("environments plan", () => {
  test("the PUT carries the settings alone, and every nested write follows it in wire order", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
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
    const planned = await plan(api, declared);
    expect(api.mutations()).toEqual([]);
    expect(planned.ops.map((op) => op.role)).toEqual([
      "update",
      "createVariable",
      "updateVariable",
      "removeVariable",
    ]);
    const result = await apply(api, declared);
    const put = api.calls.find((c) => c.method === "PUT");
    expect(put?.payload).toEqual({ wait_timer: 5 });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/environments/prod",
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/UPD",
      "DELETE /repos/o/r/environments/prod/variables/GONE",
    ]);
    expect(api.calls.find((c) => c.method === "POST")?.payload).toEqual({
      name: "NEW",
      value: "v1",
    });
    expect(api.calls.find((c) => c.method === "PATCH")?.payload).toEqual({ value: "v2" });
    expect(result.changes).toEqual([
      'applied environment "prod"',
      'created variable "NEW" in environment "prod"',
      'updated variable "UPD" in environment "prod"',
      'DELETED undeclared variable "GONE" in environment "prod"',
    ]);
    // The strip builds a fresh object, so the declaration the caller holds is never mutated.
    expect(declared[0]?.variables).toEqual([
      { name: "NEW", value: "v1" },
      { name: "UPD", value: "v2" },
    ]);
  });

  test.each([
    [
      "a live wait timer the entry declares",
      [{ id: 1, type: "wait_timer", wait_timer: 5 }],
      { name: "prod", wait_timer: 5 },
    ],
    ["no live rules against a bare entry", [], { name: "prod" }],
    [
      "live rules carrying the disabled values against a bare entry",
      [
        { id: 1, type: "wait_timer", wait_timer: 0 },
        { id: 2, type: "required_reviewers", prevent_self_review: false, reviewers: [] },
      ],
      { name: "prod" },
    ],
  ] as Array<[string, Array<Record<string, unknown>>, EnvironmentConfig]>)(
    "a converged environment plans nothing (%s): no PUT, no nested traffic",
    async (_what, rules, entry) => {
      // flattenEnvironment starts from wait_timer 0 / prevent_self_review false / reviewers [], and the
      // full-payload sweep treats those as nothing to preserve, whether the values come from the absence
      // of a rule or from a rule that carries the disabled value itself.
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod", { protection_rules: rules }),
      });
      expect(await plan(api, [entry])).toEqual({ ops: [], notes: [], drift: [] });
      expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        "GET /repos/o/r/environments/prod",
      ]);
    },
  );

  test("a declared key the environment GET never echoes is drift with the never-converges note naming it", async () => {
    // The entry is open so a field GitHub ships tomorrow is declarable, but a key the GET lacks (a typo
    // of wait_timer here) would re-PUT on every apply; the note says so beside the drift.
    const api = new MockApi({ "GET /repos/o/r/environments/prod": liveEnv("prod") });
    const checked = await check(api, [{ name: "prod", wait_timers: 5 } as EnvironmentConfig]);
    expect(checked.drift).toEqual([
      "environments[prod].wait_timers: declared 5 but the API response has no such field (new or write-only field?)",
    ]);
    expect(checked.notes).toEqual([
      'environments[prod]: declared key "wait_timers" does not exist on the live environment, so if GitHub ignores it this PUT will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
    ]);
    // Only a key the GET lacks earns the note: an ordinary value mismatch stays plain drift.
    const mismatch = await check(api, [{ name: "prod", wait_timer: 10 }]);
    expect(mismatch.notes).toEqual([]);
  });

  test("an entry key the GET omits is plain drift the PUT resolves: no note, one PUT, converged", async () => {
    // GitHub marks deployment_branch_policy optional on the environment: one that never set a policy
    // reports without the key. The key is in the entry shape, so it is not a phantom.
    const api = fragmentFake(environmentsSection, environmentsMockHandlers, {
      environments: { prod: { name: "prod", protection_rules: [] } },
    });
    const policy = { protected_branches: true, custom_branch_policies: false };
    const { first, second } = await provePlanIdempotent(environmentsSection, api, [
      { name: "prod", deployment_branch_policy: policy },
    ]);
    expect(first.notes).toEqual([]);
    expect(planDrift(first)).toEqual([
      "environments[prod].deployment_branch_policy: expected object, live has undefined",
    ]);
    expect(api.writes).toEqual(["PUT /repos/o/r/environments/prod"]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("an omitted live branch policy offers null as its clearing spelling, the one the slice accepts for that object", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod", {
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      }),
    });
    expect((await check(api, [{ name: "prod" }])).drift).toEqual([
      'environments[prod].deployment_branch_policy: live has {"protected_branches":true,"custom_branch_policies":false} but the settings file omits it, ' +
        "so apply would REMOVE it; declare deployment_branch_policy to keep it, or deployment_branch_policy: null to remove it on purpose",
    ]);
  });

  test("a missing environment plans its PUT with the missing line, in both modes", async () => {
    const api = new MockApi({ "PUT /repos/o/r/environments/prod": { data: { name: "prod" } } });
    const planned = await plan(api, [{ name: "prod", wait_timer: 5 }]);
    expect(planned.ops).toEqual([
      {
        role: "update",
        params: { environment_name: "prod" },
        payload: { wait_timer: 5 },
        drift: [
          "environments[prod]: missing - declared in the settings file but not on the repo; apply will create it",
        ],
        change: 'applied environment "prod"',
        describe: 'upserting environment "prod"',
        capture: undefined,
      },
    ]);
    expect((await apply(api, [{ name: "prod", wait_timer: 5 }])).changes).toEqual([
      'applied environment "prod"',
    ]);
  });
});

describe("environments variables check mode", () => {
  const liveProd = liveEnv("prod", {
    protection_rules: [{ id: 1, type: "wait_timer", wait_timer: 5 }],
  });

  test("an entry declaring variables alone against a live wait timer: check names the timer the PUT would clear, apply refuses the PUT and writes nothing of the entry", async () => {
    const routes = {
      "GET /repos/o/r/environments/prod": liveProd,
      [VARIABLES_LIST]: variablesBody([]),
    };
    const desired = [{ name: "prod", variables: [{ name: "A", value: "1" }] }];
    const checked = await check(new MockApi(routes, { unroutedMutations: "succeed" }), desired);
    expect(checked.drift).toEqual([
      "environments[prod].wait_timer: live has 5 but the settings file omits it, so apply would REMOVE it; declare wait_timer to keep it, or wait_timer: 0 to remove it on purpose",
      'environments[prod].variables[A]: missing - declared in the settings file but not on environment "prod"; apply will create it',
    ]);
    const api = new MockApi(routes, { unroutedMutations: "succeed" });
    await expect(apply(api, desired)).rejects.toThrow(
      "environments[prod]: not applied - the update would remove a live value the settings file omits. " +
        "environments[prod].wait_timer: live has 5 but the settings file omits it, so apply would REMOVE it; declare wait_timer to keep it, or wait_timer: 0 to remove it on purpose",
    );
    // The variables POST is planned after the PUT and never reached: the refusal leaves the whole entry untouched.
    expect(api.mutations()).toEqual([]);
  });

  test.each([
    [
      "value drift and an undeclared variable",
      [
        { name: "A", value: "2" },
        { name: "B", value: "x" },
      ],
      [
        'environments[prod].variables[A].value: declared "1" != live "2"; apply will set the declared value',
        "environments[prod].variables[B]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
      ],
    ],
    [
      "a missing declared variable",
      [],
      [
        'environments[prod].variables[A]: missing - declared in the settings file but not on environment "prod"; apply will create it',
      ],
    ],
  ])(
    "%s report drift; the environment diff excludes variables and nothing is written",
    async (_what, live, drift) => {
      const api = new MockApi(
        {
          "GET /repos/o/r/environments/prod": liveProd,
          [VARIABLES_LIST]: variablesBody(live),
        },
        // A fake that would accept any write: planning must still issue none.
        { unroutedMutations: "succeed" },
      );
      const result = await check(api, [
        { name: "prod", wait_timer: 5, variables: [{ name: "A", value: "1" }] },
      ]);
      // A variables key leaking into subsetDiff would add an "environments[prod].variables: declared ..." line here.
      expect(result.drift).toEqual(drift);
      expect(api.mutations()).toEqual([]);
    },
  );
});

describe("environments variables case-insensitive matching", () => {
  test.each([
    ["an equal value plans no write", "same", "same", [], undefined, []],
    [
      "a differing value is a PATCH at the LIVE name",
      "old",
      "new",
      ["PATCH /repos/o/r/environments/prod/variables/DEPLOY_REGION"],
      { value: "new" },
      ['updated variable "deploy_region" in environment "prod"'],
    ],
  ])(
    "a case-differing live name matches and only the value is compared: %s",
    async (_what, liveValue, declaredValue, mutations, patchPayload, changes) => {
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [VARIABLES_LIST]: variablesBody([{ name: "DEPLOY_REGION", value: liveValue }]),
      }).allowMutations("PATCH /repos/o/r/environments/prod/variables/DEPLOY_REGION");
      const result = await apply(api, [
        { name: "prod", variables: [{ name: "deploy_region", value: declaredValue }] },
      ]);
      expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual(mutations);
      expect(api.calls.find((c) => c.method === "PATCH")?.payload).toEqual(patchPayload);
      expect(result.changes).toEqual(changes);
    },
  );
});

describe("environments variables undeclared policy", () => {
  const LEGACY_KEPT =
    'variable "LEGACY" exists on environment "prod" but is not declared in the settings file; kept under "_undeclared: keep" - add it to the settings file to manage it, or set "_undeclared: delete" to have apply DELETE it';

  test.each([
    [
      "the wrapped _undeclared:keep form keeps the live variable as a note in both modes",
      { _undeclared: "keep", entries: [] },
      { drift: [], notes: [LEGACY_KEPT], changes: [], mutations: [] },
    ],
    [
      "the plain array form deletes it by default",
      [],
      {
        drift: [
          "environments[prod].variables[LEGACY]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
        ],
        notes: [],
        changes: ['DELETED undeclared variable "LEGACY" in environment "prod"'],
        mutations: ["DELETE /repos/o/r/environments/prod/variables/LEGACY"],
      },
    ],
  ] as Array<[string, EnvironmentConfig["variables"], Outcome]>)(
    "an undeclared live variable: %s",
    async (_what, variables, expected) => {
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [VARIABLES_LIST]: variablesBody([{ name: "LEGACY", value: "x" }]),
      }).allowMutations("DELETE /repos/o/r/environments/prod/variables/LEGACY");
      const checked = await check(api, [{ name: "prod", variables }]);
      expect(api.mutations()).toEqual([]);
      const applied = await apply(api, [{ name: "prod", variables }]);
      expect({
        drift: checked.drift,
        notes: checked.notes,
        changes: applied.changes,
        mutations: api.mutations().map((m) => `${m.method} ${m.path}`),
      }).toEqual(expected);
      expect(applied.notes).toEqual(checked.notes);
    },
  );
});

describe("environments variables shape", () => {
  test("an extra entry field rides the POST and PATCH verbatim, with a phantom note", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [VARIABLES_LIST]: variablesBody([{ name: "UPD", value: "old" }]),
    }).allowMutations(
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/UPD",
    );
    const result = await apply(api, [
      {
        name: "prod",
        variables: [
          { name: "NEW", value: "v1", extra_field: "x" } as EnvironmentVariableConfig,
          { name: "UPD", value: "new", extra_field: "y" } as EnvironmentVariableConfig,
        ],
      },
    ]);
    expect(api.calls.find((c) => c.method === "POST")?.payload).toEqual({
      name: "NEW",
      value: "v1",
      extra_field: "x",
    } as EnvironmentVariableConfig);
    expect(api.calls.find((c) => c.method === "PATCH")?.payload).toEqual({
      value: "new",
      extra_field: "y",
    });
    const phantom =
      'environments[prod].variables[UPD]: declared key "extra_field" does not exist on the live variable, so if GitHub ignores it this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file';
    expect(result.notes).toEqual([phantom]);
    const checked = await check(api, [
      {
        name: "prod",
        variables: [{ name: "UPD", value: "old", extra_field: "y" } as EnvironmentVariableConfig],
      },
    ]);
    expect(checked.drift).toEqual([
      'environments[prod].variables[UPD].extra_field: declared "y" but the API response has no such field (new or write-only field?)',
    ]);
    expect(checked.notes).toEqual([phantom]);
  });
});

// --- Nested per-environment secrets -----------------------------------------

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

describe("environments nested secrets apply mode", () => {
  test("same-named secrets in sibling environments seal each environment's OWN value, with the key read after the PUT", async () => {
    // A lookup keyed by secret name alone would seal one value into both scopes; staging's key is readable only after its PUT, so the thunk reads it
    // then, never at plan time.
    await mockSodiumReady();
    const api = new MockApi({
      "PUT /repos/o/r/environments/staging": { data: { name: "staging" } },
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [PROD_SECRETS_LIST]: secretsBody(["DEPLOY_TOKEN"]),
      [STAGING_KEY]: { data: { key_id: "k-stg", key: MOCK_SECRETS_PUBLIC_KEY } },
      [PROD_KEY]: { data: { key_id: "k-prod", key: MOCK_SECRETS_PUBLIC_KEY } },
    }).allowMutations(
      "PUT /repos/o/r/environments/staging/secrets/DEPLOY_TOKEN",
      "PUT /repos/o/r/environments/prod/secrets/DEPLOY_TOKEN",
    );
    const declared = [
      { name: "staging", secrets: [{ name: "DEPLOY_TOKEN", value: "$STG" }] },
      { name: "prod", secrets: [{ name: "DEPLOY_TOKEN", value: "$PRD" }] },
    ];
    const planned = await plan(api, declared);
    expect(api.calls.some((c) => c.path.endsWith("/public-key"))).toBe(false);
    expect(api.calls.some((c) => c.path.startsWith("/repos/o/r/environments/staging/"))).toBe(
      false,
    );
    expect(planned.ops.map((op) => `${op.role} ${JSON.stringify(op.params)}`)).toEqual([
      'update {"environment_name":"staging"}',
      'putSecret {"environment_name":"staging","secret_name":"DEPLOY_TOKEN"}',
      'putSecret {"environment_name":"prod","secret_name":"DEPLOY_TOKEN"}',
    ]);
    const result = await apply(
      api,
      declared,
      secretTools({ $STG: "staging-plaintext", $PRD: "prod-plaintext" }),
    );
    const order = api.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf("PUT /repos/o/r/environments/staging")).toBeLessThan(
      order.indexOf(STAGING_KEY),
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
    expect(puts.map((c) => (c.payload as { key_id: string }).key_id)).toEqual(["k-stg", "k-prod"]);
    // The verb comes from the per-environment listing: staging has no DEPLOY_TOKEN, prod does.
    expect(result.changes).toEqual([
      'applied environment "staging"',
      'created secret "DEPLOY_TOKEN" in environment "staging"',
      'updated secret "DEPLOY_TOKEN" in environment "prod"',
    ]);
  });

  test("undeclared live secrets: kept with a note by default, DELETED under the knob", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [PROD_SECRETS_LIST]: secretsBody(["LEGACY"]),
    });
    const kept = await apply(api, [{ name: "prod", secrets: [] }]);
    expect(kept.notes.join("\n")).toContain(
      'prod environment secret "LEGACY" exists on the environment but is not declared',
    );
    expect(api.calls.filter((c) => c.path.includes("/secrets/"))).toEqual([]);

    const api2 = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [PROD_SECRETS_LIST]: secretsBody(["LEGACY"]),
    }).allowMutations("DELETE /repos/o/r/environments/prod/secrets/LEGACY");
    const deleted = await apply(api2, [
      { name: "prod", secrets: { _undeclared: "delete", entries: [] } },
    ]);
    expect(deleted.changes).toEqual(['DELETED undeclared secret "LEGACY" in environment "prod"']);
    expect(api2.calls.some((c) => c.path.endsWith("/public-key"))).toBe(false);
  });

  test.each([
    ["a missing key_id", { key: MOCK_SECRETS_PUBLIC_KEY }, /pair \(key_id is missing\)/],
    ["a key that is not base64", { key_id: "k", key: "not base64!" }, /is not valid base64/],
    [
      "a key of the wrong length",
      { key_id: "k", key: Buffer.from("short").toString("base64") },
      /decodes to 5 bytes where an X25519 public key has 32/,
    ],
    [
      "a right-sized key that is not a usable point",
      { key_id: "k", key: Buffer.alloc(32).toString("base64") },
      /is not a usable X25519 public key/,
    ],
  ])(
    "a sealing key the endpoint cannot supply (%s) fails the secret PUT loudly, naming the scope",
    async (_what, body, defect) => {
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [PROD_SECRETS_LIST]: secretsBody([]),
        [PROD_KEY]: { data: body },
      }).allowMutations("PUT /repos/o/r/environments/prod/secrets/S");
      const attempt = apply(
        api,
        [{ name: "prod", secrets: [{ name: "S", value: "$S" }] }],
        secretTools({ $S: "v" }),
      );
      await expect(attempt).rejects.toThrow(
        /^environments: GET \/repos\/\{owner\}\/\{repo\}\/environments\/\{environment_name\}\/secrets\/public-key \(the environments\[prod\]\.secrets sealing key\) returned /,
      );
      await expect(attempt).rejects.toThrow(defect);
      expect(api.mutations()).toEqual([]);
    },
  );
});

describe("environments nested secrets check mode", () => {
  test("declared-but-missing is drift with the per-environment label; the note names the environment", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [PROD_SECRETS_LIST]: secretsBody(["LEGACY"]),
    });
    const result = await check(api, [
      { name: "prod", secrets: [{ name: "DEPLOY_TOKEN", value: "$D" }] },
    ]);
    expect(result.drift).toEqual([
      "environments[prod].secrets[DEPLOY_TOKEN]: missing - declared in the settings file but not on the environment; apply will create it",
    ]);
    const cannotVerify = result.notes.filter((n: string) => n.includes("cannot be read back"));
    expect(cannotVerify).toHaveLength(1);
    expect(cannotVerify[0]).toContain("prod environment secret values");
    expect(api.mutations()).toEqual([]);
    expect(api.calls.some((c) => c.path.endsWith("/public-key"))).toBe(false);
  });
});

describe("environments nested secrets validation and shape", () => {
  test("the singular entry-level `secret` key is rejected by name", () => {
    // A singular `secret` would ride the environment PUT verbatim and configure nothing.
    const misplaced = environmentsSection.shape.safeParse([
      { name: "prod", secret: [{ name: "A", value: "$A" }] },
    ]);
    expect(misplaced.success).toBe(false);
    expect(JSON.stringify(misplaced.error?.issues)).toContain(
      "belong under the entry's `secrets` list",
    );
  });

  test("secretValues walks every entry's secrets list and survives malformed containers", () => {
    // The double cast feeds secretValues a pre-validation document slice on purpose: its contract is defensiveness against any merged value.
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

/** A live prod environment with the custom-branch-policies flag set as given. */
function liveProdWithFlag(custom: boolean) {
  return liveEnv("prod", {
    deployment_branch_policy: { protected_branches: !custom, custom_branch_policies: custom },
  });
}

describe("environments deployment branch policies apply mode", () => {
  test("creates missing, replaces a type flip (delete + recreate), deletes undeclared", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
      [POLICIES_LIST]: policiesBody([
        { id: 41, name: "v*", type: "branch" },
        { id: 42, name: "legacy/*", type: "branch" },
      ]),
    }).allowMutations(
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/41",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/42",
    );
    const result = await apply(api, [
      envWithPolicies([{ name: "release/*" }, { name: "v*", type: "tag" }]),
    ]);
    // The flag object matches live, so the environment itself plans no PUT.
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/41",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/42",
    ]);
    // The plain create omits type (the upstream default "branch" applies); the recreate carries the declared one.
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts[0]?.payload).toEqual({ name: "release/*" });
    expect(posts[1]?.payload).toEqual({ name: "v*", type: "tag" });
    expect(result.changes).toEqual([
      'created deployment branch policy "release/*" in environment "prod"',
      'deleted deployment branch policy "v*" in environment "prod" to change its immutable type (branch -> tag)',
      'recreated deployment branch policy "v*" in environment "prod" as type tag',
      'DELETED undeclared deployment branch policy "legacy/*" from environment "prod"',
    ]);
  });

  test("a matching live pattern (type defaulted to branch) is a no-op", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
      // The spec marks every field optional; a live policy without a type reads as the upstream default "branch".
      [POLICIES_LIST]: policiesBody([{ id: 41, name: "release/*" }]),
    });
    const result = await apply(api, [envWithPolicies([{ name: "release/*" }])]);
    expect(result.changes).toEqual([]);
  });

  test("a live policy without a name fails loudly instead of being silently skipped", async () => {
    // A nameless policy has no identity to reconcile by; skipping it would let the default delete policy neither remove nor note it, so check could
    // report falsely clean.
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
      [POLICIES_LIST]: policiesBody([{ id: 41, type: "branch" }]),
    });
    await expect(plan(api, [envWithPolicies([{ name: "release/*" }])])).rejects.toThrow(
      /returned a policy without a name/,
    );
  });
});

describe("environments deployment branch policies check mode", () => {
  test("missing, type-flip, and undeclared patterns report drift without writing", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
      [POLICIES_LIST]: policiesBody([
        { id: 41, name: "v*", type: "branch" },
        { id: 42, name: "legacy/*", type: "branch" },
      ]),
    });
    const result = await check(api, [
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

  test("a live environment with the flag off earns a note, never lists patterns, and plans the declared ones as unverified creates", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveProdWithFlag(false),
    });
    const result = await check(api, [envWithPolicies([{ name: "release/*" }])]);
    // The flag drift comes from the environment subsetDiff; the pattern's line claims nothing about what the flag hides.
    expect(result.drift).toEqual([
      "environments[prod].deployment_branch_policy.protected_branches: false != true",
      "environments[prod].deployment_branch_policy.custom_branch_policies: true != false",
      "environments[prod].deployment_branch_policies[release/*]: not verifiable until custom_branch_policies is true; apply will create it once the flag is set",
    ]);
    expect(result.notes).toEqual([
      "environments[prod].deployment_branch_policies: patterns are not verifiable until custom_branch_policies is true; apply will set the flag and create the declared patterns, and any pattern already behind the flag reconciles on the next run",
    ]);
    expect(api.calls.some((c) => c.path.includes("/deployment-branch-policies"))).toBe(false);
  });
});

describe("environments parse rules", () => {
  test("every combination GitHub 422s or never reads back is refused at parse time, naming the key and the fix", () => {
    // Shape rules, not a plan() hook, so upfront validation rejects the document in both modes before any section writes (the apply-mode preflight
    // swallows non-permission hook errors).
    // The fixtures are the set the published-schema test also runs, so each zod rule and its JSON Schema twin face the same cases.
    const shape = environmentsSection.shape;
    for (const fixture of ENVIRONMENT_PARSE_FIXTURES) {
      const parsed = shape.safeParse([fixture.entry]);
      expect(parsed.success, fixture.name).toBe(fixture.valid);
      if (fixture.valid) {
        continue;
      }
      const issues = (parsed.error?.issues ?? []).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
      // The issue points at the offending key, so the document-validation error names environments[N].<key>.
      expect(issues, fixture.name).toContainEqual({
        path: `0.${fixture.path}`,
        message: expect.stringContaining(fixture.refusal),
      });
    }
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
  test("enables a missing rule via ONE apps fetch at plan, keeps an undeclared one by default", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      "PUT /repos/o/r/environments/prod": { data: { name: "prod" } },
      [RULES_LIST]: rulesBody([liveRule(41, "region-guard"), liveRule(42, "change-window")]),
      [RULE_APPS_LIST]: ruleAppsBody([
        { id: 3515, slug: "deploy-gate" },
        { id: 3516, slug: "region-guard" },
      ]),
    }).allowMutations(RULE_CREATE);
    const declared = [
      {
        name: "prod",
        wait_timer: 5,
        deployment_protection_rules: [{ app: "deploy-gate" }, { app: "region-guard" }],
      },
    ];
    await plan(api, declared);
    // The Apps list resolves the missing slug at plan, ahead of any write.
    expect(api.calls.filter((c) => c.path.includes("/apps"))).toHaveLength(1);
    expect(api.mutations()).toEqual([]);
    const result = await apply(api, declared);
    expect(api.calls.find((c) => c.method === "PUT")?.payload).toEqual({ wait_timer: 5 });
    const order = api.calls.map((c) => `${c.method} ${c.path}`);
    // One fetch per plan (the apply above re-plans); the executing POST reuses its plan's resolution.
    expect(order.filter((c) => c.includes("/apps"))).toHaveLength(2);
    expect(order.indexOf("PUT /repos/o/r/environments/prod")).toBeLessThan(
      order.indexOf(RULE_CREATE),
    );
    const posts = api.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.payload).toEqual({ integration_id: 3515 });
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
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([liveRule(41, "deploy-gate")]),
    });
    const result = await apply(api, [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(api.calls.some((c) => c.path.includes("/apps"))).toBe(false);
    expect(result.changes).toEqual([]);
  });

  test("two available Apps under one slug fail the plan of an existing environment before any write, naming both", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([]),
      [RULE_APPS_LIST]: ruleAppsBody([
        { id: 3516, slug: "region-guard" },
        { id: 9999, slug: "region-guard" },
      ]),
    }).allowMutations(RULE_CREATE, "PUT /repos/o/r/environments/prod");
    await expect(
      apply(api, [
        { name: "prod", wait_timer: 5, deployment_protection_rules: [{ app: "region-guard" }] },
      ]),
    ).rejects.toThrow(
      new Error(
        "environments: GitHub holds protection-rule Apps that resolve to one identity: " +
          '"region-guard (app id 3516)" and "region-guard (app id 9999)". This section manages one ' +
          "protection-rule App per identity, so it cannot tell them apart; delete all but one of each on GitHub, then run again",
      ),
    );
    expect(api.mutations()).toEqual([]);
  });

  test.each([
    [
      "names the available slugs",
      [
        { id: 3515, slug: "deploy-gate" },
        { id: 3516, slug: "region-guard" },
      ],
      // deploy-gate comes first on purpose: every missing slug resolves before the first POST, so the unknown sibling aborts before anything is
      // enabled.
      [{ app: "deploy-gate" }, { app: "not-installed" }],
      'environments: the deployment protection rule App "not-installed" is not available to ' +
        'environment "prod" (the available Apps are "deploy-gate", "region-guard"). Install the ' +
        "GitHub App providing the rule on this repository, or declare one of the available slugs",
    ],
    [
      // A real user state, not a contract break: no protection-rule App is installed, so the error lists nothing.
      "says no Apps are available at all when the listing is EMPTY",
      [],
      [{ app: "deploy-gate" }],
      'environments: the deployment protection rule App "deploy-gate" is not available to ' +
        'environment "prod" (no protection-rule Apps are available to it). Install the GitHub ' +
        "App providing the rule on this repository, or declare one of the available slugs",
    ],
  ])(
    "a declared slug the apps listing does not carry fails loudly and %s",
    async (_what, apps, rules, message) => {
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [RULES_LIST]: rulesBody([]),
        [RULE_APPS_LIST]: ruleAppsBody(apps),
      }).allowMutations(RULE_CREATE);
      await expect(
        apply(api, [{ name: "prod", deployment_protection_rules: rules }]),
      ).rejects.toThrow(message);
      expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    },
  );

  test("a live rule without an app slug fails loudly instead of being silently skipped", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([{ id: 41, node_id: "n", enabled: true, app: {} }]),
    });
    await expect(
      plan(api, [{ name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] }]),
    ).rejects.toThrow(/returned a rule without an app slug/);
  });

  test("absent envelope keys read as an empty list (the spec marks both optional)", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: { data: { total_count: 0 } },
      [RULE_APPS_LIST]: ruleAppsBody([{ id: 3515, slug: "deploy-gate" }]),
    }).allowMutations(RULE_CREATE);
    const result = await apply(api, [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(result.changes).toEqual([
      'enabled deployment protection rule "deploy-gate" in environment "prod"',
    ]);
  });

  test("a PRESENT non-array envelope value is a loud contract violation, never an empty list", async () => {
    // null is present-but-not-a-list too: the spec types the key as a plain array, so only an absent key may read as empty.
    for (const garbage of ["garbage", null]) {
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [RULES_LIST]: { data: { custom_deployment_protection_rules: garbage } },
      });
      await expect(
        plan(api, [{ name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] }]),
      ).rejects.toThrow(
        /returned a body outside the documented shape - custom_deployment_protection_rules/,
      );
    }
  });

  test("a live rule with a non-numeric id fails loudly before any disable", async () => {
    // A null or string id would otherwise serialize into the DELETE path (".../deployment_protection_rules/null") and address nothing.
    for (const id of [null, "41"]) {
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [RULES_LIST]: rulesBody([{ ...liveRule(41, "change-window"), id }]),
      });
      await expect(
        plan(api, [
          { name: "prod", deployment_protection_rules: { _undeclared: "delete", entries: [] } },
        ]),
      ).rejects.toThrow(
        /returned a body outside the documented shape - custom_deployment_protection_rules\[0\]\.id/,
      );
      expect(api.mutations()).toEqual([]);
    }
  });

  test.each([
    [
      "a declared gate is re-enabled, never read as clean",
      liveRule(41, "deploy-gate"),
      [{ app: "deploy-gate" }],
      {
        drift: [
          "environments[prod].deployment_protection_rules[deploy-gate]: missing - declared in the settings file but not enabled on the environment; apply will enable it if the App is available to this environment",
        ],
        notes: [],
        changes: ['enabled deployment protection rule "deploy-gate" in environment "prod"'],
        mutations: [RULE_CREATE],
      },
    ],
    [
      "an undeclared rule under _undeclared: delete is neither noted nor disabled",
      liveRule(41, "change-window"),
      { _undeclared: "delete", entries: [] },
      { drift: [], notes: [], changes: [], mutations: [] },
    ],
  ] as Array<
    [string, Record<string, unknown>, EnvironmentConfig["deployment_protection_rules"], Outcome]
  >)(
    "a live rule reported as disabled is not an active gate: %s",
    async (_what, rule, declared, expected) => {
      // The endpoint documents enabled rules only, so this is a belt over the contract: a declared gate whose live rule says enabled: false is
      // re-enabled, never read as clean. Under _undeclared: delete the goal is "no undeclared gate is on", which a disabled rule already
      // satisfies; a DELETE aimed at a disabled id would likely 404 mid-apply for a no-op.
      const api = new MockApi({
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [RULES_LIST]: rulesBody([{ ...rule, enabled: false }]),
        [RULE_APPS_LIST]: ruleAppsBody([{ id: 3515, slug: "deploy-gate" }]),
      }).allowMutations(RULE_CREATE);
      const entry = { name: "prod", deployment_protection_rules: declared };
      const planned = await plan(api, [entry]);
      const result = await apply(api, [entry]);
      expect({
        drift: planDrift(planned),
        notes: result.notes,
        changes: result.changes,
        mutations: api.mutations().map((m) => `${m.method} ${m.path}`),
      }).toEqual(expected);
    },
  );
});

describe("environments deployment protection rules check mode", () => {
  test("missing declared rules are drift; undeclared ones split by policy; nothing written", async () => {
    const api = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([liveRule(41, "change-window")]),
      [RULE_APPS_LIST]: ruleAppsBody([{ id: 3515, slug: "deploy-gate" }]),
    });
    const kept = await check(api, [
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
    ]);
    expect(kept.drift).toEqual([
      "environments[prod].deployment_protection_rules[deploy-gate]: missing - declared in the settings file but not enabled on the environment; apply will enable it if the App is available to this environment",
    ]);
    expect(kept.notes.join("\n")).toContain('deployment protection rule "change-window"');
    // The missing rule resolves its App at plan, so check reads the listing once and writes nothing.
    expect(api.calls.filter((c) => c.path.includes("/apps"))).toHaveLength(1);
    expect(api.mutations()).toEqual([]);

    const api2 = new MockApi({
      "GET /repos/o/r/environments/prod": liveEnv("prod"),
      [RULES_LIST]: rulesBody([liveRule(41, "change-window")]),
    });
    const deleted = await check(api2, [
      { name: "prod", deployment_protection_rules: { _undeclared: "delete", entries: [] } },
    ]);
    expect(deleted.drift).toEqual([
      'environments[prod].deployment_protection_rules[change-window]: undeclared - not in the settings file and "_undeclared: delete" is set, so apply will DISABLE it; add it to the settings file to keep it',
    ]);
  });
});

describe("environments missing-environment planning across the nested families", () => {
  // The empty MockApi 404s the environment GET, so every family plans creates without a sub-resource read.
  test.each([
    [
      "variables",
      { name: "prod", variables: [{ name: "A", value: "1" }] },
      "environments[prod].variables: not verifiable while the environment is missing; apply will create the environment and reconcile the declared variables",
      "/variables",
      'environments[prod].variables[A]: missing - declared in the settings file but not on environment "prod"; apply will create it',
    ],
    [
      "secrets",
      { name: "prod", secrets: [{ name: "S", value: "$S" }] },
      "environments[prod].secrets: not verifiable while the environment is missing; apply will create the environment and reconcile the declared secrets",
      "/secrets",
      "environments[prod].secrets[S]: missing - declared in the settings file but not on the environment; apply will create it",
    ],
    [
      "deployment_branch_policies",
      envWithPolicies([{ name: "release/*" }]),
      "environments[prod].deployment_branch_policies: not verifiable while the environment is missing; apply will create the environment and reconcile the declared patterns",
      "/deployment-branch-policies",
      "environments[prod].deployment_branch_policies[release/*]: missing - declared in the settings file but not on the environment; apply will create it",
    ],
    [
      "deployment_protection_rules",
      { name: "prod", deployment_protection_rules: [{ app: "deploy-gate" }] },
      "environments[prod].deployment_protection_rules: not verifiable while the environment is missing; apply will create the environment and reconcile the declared protection rules",
      "/deployment_protection_rules",
      "environments[prod].deployment_protection_rules[deploy-gate]: missing - declared in the settings file but not enabled on the environment; apply will enable it if the App is available to this environment",
    ],
  ] as Array<[string, EnvironmentConfig, string, string, string]>)(
    "%s: the sub-resource read is skipped, the note says it is unverifiable, and the create is planned",
    async (key, entry, expectedNote, subResourcePath, createDrift) => {
      const api = new MockApi({});
      const result = await check(api, [entry]);
      expect(result.drift).toEqual([
        "environments[prod]: missing - declared in the settings file but not on the repo; apply will create it",
        createDrift,
      ]);
      // The secrets engine states once per scope that values never read back, beside the missing-environment note.
      expect(result.notes).toEqual(
        key === "secrets"
          ? [
              expectedNote,
              "environments[prod].secrets: prod environment secret values cannot be read back from GitHub, so check mode cannot verify them, only that each declared secret exists; apply re-seals and rewrites every declared value on every run",
            ]
          : [expectedNote],
      );
      expect(api.calls.filter((c) => c.path.includes(subResourcePath))).toEqual([]);
    },
  );
});

describe("environments nested lists validation", () => {
  test.each([
    [
      "variables (case-insensitively)",
      {
        name: "prod",
        variables: [
          { name: "Region", value: "a" },
          { name: "REGION", value: "b" },
        ],
      },
      "[0].variables[1].name",
      '"REGION" names the same variable of the "prod" environment as "Region" declared earlier; keep exactly one entry per variable of the "prod" environment',
    ],
    [
      "secrets (case-insensitively), in the wrapped form under .entries",
      {
        name: "prod",
        secrets: {
          entries: [
            { name: "token", value: "$A" },
            { name: "TOKEN", value: "$B" },
          ],
        },
      },
      "[0].secrets.entries[1].name",
      '"TOKEN" names the same secret of the "prod" environment as "token" declared earlier; keep exactly one entry per secret of the "prod" environment',
    ],
    [
      "deployment_branch_policies",
      envWithPolicies([{ name: "release/*" }, { name: "release/*", type: "tag" }]),
      "[0].deployment_branch_policies[1].name",
      '"release/*" names the same deployment branch policy of the "prod" environment as "release/*" declared earlier; keep exactly one entry per deployment branch policy of the "prod" environment',
    ],
    [
      "deployment_protection_rules",
      {
        name: "prod",
        deployment_protection_rules: [{ app: "deploy-gate" }, { app: "deploy-gate" }],
      },
      "[0].deployment_protection_rules[1].app",
      '"deploy-gate" names the same deployment protection rule App of the "prod" environment as "deploy-gate" declared earlier; keep exactly one entry per deployment protection rule App of the "prod" environment',
    ],
  ] as Array<[string, EnvironmentConfig, string, string]>)(
    "two %s entries naming one resource are a validate issue naming the environment, so the document fails before any write",
    (_key, entry, path, message) => {
      expect(environmentsSection.validate([entry])).toEqual([{ path, message }]);
    },
  );
});

describe("environments nested lists shape", () => {
  // Loose entries carry the write verbatim, so a field GitHub ships tomorrow is declarable the day it appears; an entry whose write carries only
  // the resolved value (a sealed secret, an integration_id) has no destination for an extra key, so it is rejected rather than silently doing
  // nothing.
  test.each([
    [
      "variables",
      "rides the write",
      [{ name: "A", value: "1" }],
      (entries: unknown) => ({ name: "prod", variables: entries }),
    ],
    [
      "secrets",
      "is rejected",
      [{ name: "A", value: "$A" }],
      (entries: unknown) => ({ name: "prod", secrets: entries }),
    ],
    [
      "deployment_branch_policies",
      "rides the write",
      [{ name: "release/*" }, { name: "v*", type: "tag" }],
      envWithPolicies,
    ],
    [
      "deployment_protection_rules",
      "is rejected",
      [{ app: "deploy-gate" }],
      (entries: unknown) => ({ name: "prod", deployment_protection_rules: entries }),
    ],
  ] as Array<
    [
      string,
      "rides the write" | "is rejected",
      [Record<string, unknown>, ...Record<string, unknown>[]],
      (entries: unknown) => unknown,
    ]
  >)(
    "%s: both declared forms parse, the wrapper is strict, and an extra entry field %s",
    (_key, extraField, entries, entryWith) => {
      const parses = (declared: unknown) =>
        environmentsSection.shape.safeParse([entryWith(declared)]).success;
      expect(parses(entries)).toBe(true);
      expect(parses({ _undeclared: "keep", entries })).toBe(true);
      expect(parses({ _undeclared: "delete", entries })).toBe(true);
      const accepted = extraField === "rides the write";
      expect(parses([{ ...entries[0], future: "x" }])).toBe(accepted);
      expect(parses([{ ...entries[0], typo: 1 }])).toBe(accepted);
      // The wrapper stays strict: its keys are this action's own vocabulary.
      expect(parses({ entires: [], entries: [] })).toBe(false);
    },
  );
});

describe("environments nested lists undeclared policy", () => {
  const RULE_DISABLE = "DELETE /repos/o/r/environments/prod/deployment_protection_rules/41";

  test.each([
    [
      "keep keeps a live deployment branch policy as a note",
      {
        "GET /repos/o/r/environments/prod": liveProdWithFlag(true),
        [POLICIES_LIST]: policiesBody([{ id: 41, name: "legacy/*", type: "branch" }]),
      },
      envWithPolicies({ _undeclared: "keep", entries: [] }),
      {
        mutations: [],
        changes: [],
        notes: [
          'deployment branch policy "legacy/*" exists on environment "prod" but is not declared',
        ],
      },
    ],
    [
      "delete DISABLES a live deployment protection rule by id",
      {
        "GET /repos/o/r/environments/prod": liveEnv("prod"),
        [RULES_LIST]: rulesBody([liveRule(41, "change-window")]),
      },
      { name: "prod", deployment_protection_rules: { _undeclared: "delete", entries: [] } },
      {
        mutations: [RULE_DISABLE],
        changes: [
          'DISABLED undeclared deployment protection rule "change-window" in environment "prod"',
        ],
        notes: [],
      },
    ],
  ] as Array<
    [
      string,
      Record<string, Route>,
      EnvironmentConfig,
      { mutations: string[]; changes: string[]; notes: string[] },
    ]
  >)(
    "the wrapper's own _undeclared overrides the nested default: %s",
    async (_what, routes, entry, expected) => {
      const api = new MockApi(routes).allowMutations(RULE_DISABLE);
      const result = await apply(api, [entry]);
      expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual(expected.mutations);
      expect(result.changes).toEqual(expected.changes);
      // The keep note is prose the engine owns; the row pins the part that names this section's resource.
      expect(result.notes).toHaveLength(expected.notes.length);
      for (const [index, note] of expected.notes.entries()) {
        expect(result.notes[index]).toContain(note);
      }
    },
  );
});

describe("environments deployment protection rules validation and shape", () => {
  test("a required_reviewers rule without reviewers reads prevent_self_review back as off", () => {
    // The schema refuses the flag without a reviewer, so the snapshot of such a body must not carry it.
    const flattened = flattenEnvironment({
      name: "prod",
      protection_rules: [
        { id: 7, type: "required_reviewers", prevent_self_review: true, reviewers: [] },
      ],
    });
    expect(flattened).toMatchObject({ prevent_self_review: false, reviewers: [] });
    expect(
      EnvironmentConfig.safeParse(projectOntoSchema(EnvironmentConfig, flattened)).success,
    ).toBe(true);
  });

  test("a custom-rule protection_rules entry flattens without leaking keys", () => {
    // The environment GET surfaces an enabled custom rule as the spec's third protection_rules variant ({id, node_id, type}); flattenEnvironment's
    // generic branch filters exactly those keys, so the entry can never produce false environment drift.
    const flattened = flattenEnvironment({
      name: "prod",
      protection_rules: [{ id: 41, node_id: "DPR_41", type: "deploy-gate" }],
    });
    expect(flattened).toEqual({
      name: "prod",
      protection_rules: [{ id: 41, node_id: "DPR_41", type: "deploy-gate" }],
      wait_timer: 0,
      prevent_self_review: false,
      reviewers: [],
    });
  });
});

// --- Convergence over the e2e mock's own handlers ------------------------------

describe("environments convergence", () => {
  const secretEnv = { $PRD: "prod-plaintext", $NEW: "new-plaintext" };

  test("executing the plan converges: the re-plan over applied state carries only the sealed secret PUTs", async () => {
    // Every family at once: an existing environment with settings drift and every nested knob diverging, plus a missing pinned environment whose node
    // id must come from its PUT.
    await mockSodiumReady();
    const api = fragmentFake(environmentsSection, environmentsMockHandlers, {
      environments: {
        prod: {
          name: "prod",
          protection_rules: [{ id: 1, type: "wait_timer", wait_timer: 15 }],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
        legacy: { name: "legacy", protection_rules: [] },
      },
      environment_variables: {
        prod: [
          {
            name: "LOG_LEVEL",
            value: "info",
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
          {
            name: "GONE",
            value: "x",
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
        ],
      },
      environment_secrets: {
        prod: [
          {
            name: "DEPLOY_TOKEN",
            created_at: "2019-08-10T14:59:22Z",
            updated_at: "2019-08-10T14:59:22Z",
          },
          { name: "KEPT", created_at: "2019-08-10T14:59:22Z", updated_at: "2019-08-10T14:59:22Z" },
        ],
      },
      environment_branch_policies: {
        prod: [
          { id: 4001, name: "v*", type: "branch" },
          { id: 4002, name: "legacy/*", type: "branch" },
        ],
      },
      environment_protection_rules: {
        prod: [
          {
            id: 7101,
            node_id: "DPR_7101",
            enabled: true,
            app: { id: 3517, slug: "change-window", integration_url: "u", node_id: "n" },
          },
        ],
      },
      pinned_environments: ["legacy"],
    });
    const { first, second, changes } = await provePlanIdempotent(
      environmentsSection,
      api,
      [
        {
          name: "prod",
          wait_timer: 30,
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          variables: [
            { name: "DEPLOY_REGION", value: "eu-west-1" },
            { name: "log_level", value: "debug" },
          ],
          secrets: [{ name: "DEPLOY_TOKEN", value: "$PRD" }],
          deployment_branch_policies: [{ name: "release/*" }, { name: "v*", type: "tag" }],
          deployment_protection_rules: [{ app: "deploy-gate" }],
          pinned: true,
        },
        { name: "staging", pinned: true },
        { name: "legacy", pinned: false },
      ],
      secretTools(secretEnv),
    );
    expect(changes).toEqual([
      'applied environment "prod"',
      'created variable "DEPLOY_REGION" in environment "prod"',
      'updated variable "log_level" in environment "prod"',
      'DELETED undeclared variable "GONE" in environment "prod"',
      'updated secret "DEPLOY_TOKEN" in environment "prod"',
      'created deployment branch policy "release/*" in environment "prod"',
      'deleted deployment branch policy "v*" in environment "prod" to change its immutable type (branch -> tag)',
      'recreated deployment branch policy "v*" in environment "prod" as type tag',
      'DELETED undeclared deployment branch policy "legacy/*" from environment "prod"',
      'enabled deployment protection rule "deploy-gate" in environment "prod"',
      'applied environment "staging"',
      'unpinned environment "legacy"',
      'pinned environment "prod"',
      'pinned environment "staging"',
    ]);
    expect(api.writes).toEqual([
      "PUT /repos/o/r/environments/prod",
      "POST /repos/o/r/environments/prod/variables",
      "PATCH /repos/o/r/environments/prod/variables/LOG_LEVEL",
      "DELETE /repos/o/r/environments/prod/variables/GONE",
      "PUT /repos/o/r/environments/prod/secrets/DEPLOY_TOKEN",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/4001",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "DELETE /repos/o/r/environments/prod/deployment-branch-policies/4002",
      "POST /repos/o/r/environments/prod/deployment_protection_rules",
      "PUT /repos/o/r/environments/staging",
      "GRAPHQL PinEnvironment",
      "GRAPHQL PinEnvironment",
      "GRAPHQL PinEnvironment",
      // The second pass: the sealed PUT recurs by contract, nothing else.
      "PUT /repos/o/r/environments/prod/secrets/DEPLOY_TOKEN",
    ]);
    expect(first.notes).toEqual([
      "environments[prod].secrets: prod environment secret values cannot be read back from GitHub, so check mode cannot verify them, only that each declared secret exists; apply re-seals and rewrites every declared value on every run",
      'prod environment secret "KEPT" exists on the environment but is not declared in the ' +
        'settings file; kept under "_undeclared: keep" - add it to the settings file to manage ' +
        'it, or set "_undeclared: delete" to have apply DELETE it (a deleted secret\'s value is ' +
        "unrecoverable)",
      'deployment protection rule "change-window" is enabled on environment "prod" but is not declared in the settings file; kept under "_undeclared: keep" - add it to the settings file to manage it, or set "_undeclared: delete" to have apply DISABLE it',
    ]);
    expect(second.ops.map((op) => `${op.role} ${op.change}`)).toEqual([
      'putSecret updated secret "DEPLOY_TOKEN" in environment "prod"',
    ]);
  });

  test("patterns hidden behind a flag that is off reconcile on the run after the one that sets it", async () => {
    // The mock keeps patterns behind an off flag (the list route 404s): the first apply sets the flag and creates the declared ones (the hidden
    // same-name answers 303), the next converges on what was revealed.
    const api = fragmentFake(environmentsSection, environmentsMockHandlers, {
      environments: {
        prod: {
          name: "prod",
          protection_rules: [],
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
        },
      },
      environment_branch_policies: {
        prod: [
          { id: 4001, name: "v*", type: "branch" },
          { id: 4002, name: "legacy/*", type: "branch" },
        ],
      },
    });
    const desired = [envWithPolicies([{ name: "release/*" }, { name: "v*", type: "tag" }])];
    const first = await plan(api, desired);
    expect(planDrift(first)).toEqual([
      "environments[prod].deployment_branch_policy.protected_branches: false != true",
      "environments[prod].deployment_branch_policy.custom_branch_policies: true != false",
      "environments[prod].deployment_branch_policies[release/*]: not verifiable until custom_branch_policies is true; apply will create it once the flag is set",
      "environments[prod].deployment_branch_policies[v*]: not verifiable until custom_branch_policies is true; apply will create it once the flag is set",
    ]);
    const applied = await executePlan(first, environmentsSection, api, REPO, NO_SECRETS);
    expect(applied.status).toBe("applied");
    expect(api.writes).toEqual([
      "PUT /repos/o/r/environments/prod",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
      "POST /repos/o/r/environments/prod/deployment-branch-policies",
    ]);
    const second = await plan(api, desired);
    expect(planDrift(second)).toEqual([
      "environments[prod].deployment_branch_policies[v*]: the declared type differs from the live pattern's, and a policy's type is immutable; apply will delete and recreate it",
      'environments[prod].deployment_branch_policies[v*].type: "tag" != "branch"',
      "environments[prod].deployment_branch_policies[legacy/*]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    await executePlan(second, environmentsSection, api, REPO, NO_SECRETS);
    expect(await plan(api, desired)).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a secret created alongside its environment is rewritten as an update by the next plan", async () => {
    await mockSodiumReady();
    const api = fragmentFake(environmentsSection, environmentsMockHandlers, {});
    const desired = [{ name: "staging", secrets: [{ name: "NEW", value: "$NEW" }] }];
    const first = await plan(api, desired);
    expect(planDrift(first)).toEqual([
      "environments[staging]: missing - declared in the settings file but not on the repo; apply will create it",
      "environments[staging].secrets[NEW]: missing - declared in the settings file but not on the environment; apply will create it",
    ]);
    const execution = await executePlan(
      first,
      environmentsSection,
      api,
      REPO,
      secretTools(secretEnv),
    );
    expect(execution).toEqual({
      status: "applied",
      changes: ['applied environment "staging"', 'created secret "NEW" in environment "staging"'],
      notes: [],
      landed: 2,
    });
    const second = await plan(api, desired);
    expect(second.ops.map((op) => ({ role: op.role, drift: op.drift, change: op.change }))).toEqual(
      [{ role: "putSecret", drift: [], change: 'updated secret "NEW" in environment "staging"' }],
    );
    expect(second.notes).toEqual([
      "environments[staging].secrets: staging environment secret values cannot be read back from GitHub, so check mode cannot verify them, only that each declared secret exists; apply re-seals and rewrites every declared value on every run",
    ]);
  });
});

describe("environments snapshot", () => {
  const STAMPS = { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  /** What an environment without protection rules reads back as: the snapshot writes the disabled values out. */
  const UNPROTECTED = { wait_timer: 0, prevent_self_review: false, reviewers: [] };

  test("a disabled protection rule and patterns behind an off flag are not read back; a lowercase secret listing reads back under its uppercase key", async () => {
    const api = fragmentFake(environmentsSection, environmentsMockHandlers, {
      environments: {
        qa: {
          name: "qa",
          protection_rules: [],
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
        },
      },
      environment_branch_policies: { qa: [{ id: 4001, name: "hidden/*", type: "branch" }] },
      environment_protection_rules: {
        qa: [
          {
            id: 7100,
            node_id: "DPR_7100",
            enabled: false,
            app: { id: 3516, slug: "region-guard" },
          },
          { id: 7101, node_id: "DPR_7101", enabled: true, app: { id: 3515, slug: "deploy-gate" } },
        ],
      },
      environment_secrets: { qa: [{ name: "release_pat", ...STAMPS }] },
    });
    const snapshot = unwrap(
      await environmentsSection.snapshot(snapshotContext(environmentsSection, api, REPO, "fail")),
    );
    expect(snapshot).toEqual({
      value: [
        {
          name: "qa",
          ...UNPROTECTED,
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
          secrets: {
            _undeclared: "keep",
            entries: [{ name: "RELEASE_PAT", value: "$SECRET_ENVIRONMENT_QA_RELEASE_PAT" }],
          },
          deployment_protection_rules: { _undeclared: "keep", entries: [{ app: "deploy-gate" }] },
        },
      ],
      notes: [
        "environments[qa].secrets[RELEASE_PAT]: value of RELEASE_PAT is not readable; export it into the environment as SECRET_ENVIRONMENT_QA_RELEASE_PAT before apply",
      ],
    });
    expect(api.writes).toEqual([]);
  });

  test("two environment names the reference fold collapses earn one shared-variable note, its owners in code-point order whatever the listing's", () => {
    const secrets = (names: string[]) => ({
      _undeclared: "keep" as const,
      entries: names.map((name) => ({ name, value: `$${name}` })),
    });
    expect(
      sharedSecretNotes([
        { name: "prod_eu", secrets: secrets(["DEPLOY_TOKEN"]) },
        { name: "prod-eu", secrets: secrets(["DEPLOY_TOKEN", "API_KEY"]) },
        { name: "prod.eu", secrets: secrets(["DEPLOY_TOKEN"]) },
        { name: "staging", secrets: secrets(["DEPLOY_TOKEN"]) },
        { name: "dev" },
      ]),
    ).toEqual([
      "secrets: environments[prod-eu].secrets[DEPLOY_TOKEN], environments[prod.eu].secrets[DEPLOY_TOKEN], " +
        "environments[prod_eu].secrets[DEPLOY_TOKEN] all read their value from " +
        "SECRET_ENVIRONMENT_PROD_EU_DEPLOY_TOKEN; edit a reference to give one its own value",
    ]);
  });

  test("a token with only the Environments grant loses the Actions-gated keys to notes, not the section, under warn", async () => {
    const inner = fragmentFake(environmentsSection, environmentsMockHandlers, {
      environments: {
        production: {
          name: "production",
          protection_rules: [{ id: 1, type: "wait_timer", wait_timer: 5 }],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        },
      },
      environment_variables: { production: [{ name: "REGION", value: "eu", ...STAMPS }] },
      environment_branch_policies: {
        production: [{ id: 4001, name: "release/*", type: "branch" }],
      },
      environment_protection_rules: {
        production: [
          { id: 7100, node_id: "DPR_7100", enabled: true, app: { id: 3516, slug: "region-guard" } },
        ],
      },
    });
    const actionsGated = /\/(deployment-branch-policies|deployment_protection_rules)(\?|$)/;
    const api: GitHubClient = {
      tryRequest: (method, path, payload, options) =>
        actionsGated.test(path)
          ? Promise.resolve({
              error: {
                status: 403,
                message: "Resource not accessible by personal access token",
                body: "",
              },
            })
          : inner.tryRequest(method, path, payload, options),
      tryGraphql: (op, variables, slug) => inner.tryGraphql(op, variables, slug),
    };
    const snapshot = unwrap(
      await environmentsSection.snapshot(snapshotContext(environmentsSection, api, REPO, "warn")),
    );
    expect(snapshot).toEqual({
      value: [
        {
          name: "production",
          wait_timer: 5,
          prevent_self_review: false,
          reviewers: [],
          deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
          variables: { _undeclared: "delete", entries: [{ name: "REGION", value: "eu" }] },
        },
      ],
      notes: [
        "environments[production].deployment_branch_policies: left out of the snapshot - the token was denied " +
          'GET /repos/o/r/environments/production/deployment-branch-policies (environment "production"): 403 ' +
          'Resource not accessible by personal access token. To fix, grant "Actions" (read) under the PAT\'s ' +
          "Repository permissions. Note: a 404 here can also mean the environment does not exist, or that its " +
          "deployment_branch_policy does not set custom_branch_policies: true",
        "environments[production].deployment_protection_rules: left out of the snapshot - the token was denied " +
          'GET /repos/o/r/environments/production/deployment_protection_rules (environment "production"): 403 ' +
          'Resource not accessible by personal access token. To fix, grant "Actions" (read) under the PAT\'s ' +
          "Repository permissions. Note: a 404 here can also mean the environment does not exist",
      ],
    });
    expect(inner.writes).toEqual([]);
  });

  test("no environment reads back as nothing to declare", async () => {
    const api = fragmentFake(environmentsSection, environmentsMockHandlers, {});
    const snapshot = unwrap(
      await environmentsSection.snapshot(snapshotContext(environmentsSection, api, REPO, "fail")),
    );
    expect(snapshot).toEqual({ value: undefined, notes: [] });
  });

  test("the pinned environments lead in rank order with pinned: true, the rest follow without the key, and the file plans clean", async () => {
    // The listing order (web, api, sandbox) differs from the rank order (api, web), so the
    // assertion proves rank wins. Hole-y positions, as live GitHub leaves them after an unpin.
    const api = registryFake({
      environments: {
        web: { name: "web", protection_rules: [] },
        api: { name: "api", protection_rules: [] },
        sandbox: { name: "sandbox", protection_rules: [] },
      },
      pinned_environments: [
        { name: "web", position: 7 },
        { name: "api", position: 3 },
      ],
    });
    const { snapshot } = await proveSnapshotRoundTrip(environmentsSection, api);
    expect(snapshot).toEqual({
      value: [
        { name: "api", pinned: true, ...UNPROTECTED },
        { name: "web", pinned: true, ...UNPROTECTED },
        { name: "sandbox", ...UNPROTECTED },
      ],
      notes: [],
    });
  });

  test("a pin naming no listed environment stops the declared block there, so the file's pins stay a prefix of the live order", () => {
    const entries = [{ name: "Prod" }, { name: "qa" }, { name: "web" }];
    // Case-insensitive match for the leading pin; ghost is unlisted, so web (ranked after it) is not declared.
    expect(withPins(entries, ["prod", "ghost", "web"])).toEqual({
      entries: [{ name: "Prod", pinned: true }, { name: "qa" }, { name: "web" }],
      notes: [
        'environments: the pinned environment "ghost" is not in the environment listing, so its pin cannot be declared; ' +
          'the pins ranked after it ("web") are left without the pinned key too, since declared pins must lead the live list',
      ],
    });
    expect(withPins(entries, ["ghost"])).toEqual({
      entries,
      notes: [
        'environments: the pinned environment "ghost" is not in the environment listing, so its pin cannot be declared',
      ],
    });
  });

  test("a denied pins read fails the snapshot with the grant advice instead of reading as no pins", async () => {
    const inner = fragmentFake(environmentsSection, environmentsMockHandlers, {
      environments: { qa: { name: "qa", protection_rules: [] } },
    });
    const api: GitHubClient = {
      tryRequest: (method, path, payload, options) =>
        inner.tryRequest(method, path, payload, options),
      tryGraphql: () =>
        Promise.resolve({
          error: {
            status: 404,
            message: "Could not resolve to a Repository with the given name",
            body: "",
            graphqlTypes: ["NOT_FOUND"],
          },
        }),
    };
    const failure = failureOf(
      await environmentsSection.snapshot(snapshotContext(environmentsSection, api, REPO, "fail")),
    );
    expect(failure.kind).toBe("permission-denied");
    expect(failure.message).toContain(
      "environments: the token was denied GRAPHQL EnvironmentPinsSnapshot: 404 Could not resolve to a Repository " +
        'with the given name (a 404 here can also mean the resource does not exist). To fix, grant "Environments" ' +
        '(read and write) under the PAT\'s Repository permissions; declared "deployment_branch_policies" and ' +
        '"deployment_protection_rules" keys additionally need "Actions" (read) and "Administration" (read and write)',
    );
  });
});
