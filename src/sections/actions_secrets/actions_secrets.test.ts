import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { executePlan } from "../../../src/engine/execute.js";
import { runForRepo, validateSettingsDoc } from "../../../src/engine/orchestrate.js";
import { type GitHubClient, SECRET_RESPONSE_WITHHELD } from "../../../src/github/api.js";
import {
  MOCK_SECRETS_PUBLIC_KEY,
  mockSodiumReady,
  unsealSecretValue,
} from "../../../test/e2e/mock/secrets.js";
import { captureIo } from "../../../test/io/capture.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../test/sections/section-run.js";
import { validatedInput } from "../../../test/sections/validated-input.js";
import { SectionSelection } from "../../engine/section-selection.js";
import { describeProblem } from "../../problem.js";
import type { SectionInput } from "../contract/module.js";
import { driftOf, type ExecTools, type PlannedOp, planContext } from "../contract/plan.js";
import { actionsSecretsSection } from "./index.js";

const LIST = "GET /repos/o/r/actions/secrets?per_page=100&page=1";
const PUBLIC_KEY = "GET /repos/o/r/actions/secrets/public-key";
const KEY_ROUTE = { data: { key_id: "test-key-id", key: MOCK_SECRETS_PUBLIC_KEY } };
const CANNOT_VERIFY =
  "actions_secrets: Actions secret values cannot be read back from GitHub, so check mode cannot verify them, only that each declared secret exists; apply re-seals and rewrites every declared value on every run";

type Declared = SectionInput<"actions_secrets">;

function listOf(...names: string[]) {
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

/** The engine's resolver posture: always present, loud on an unresolved reference. */
function tools(resolved: Record<string, string> = {}): ExecTools & { lookups: string[] } {
  return {
    lookups: [],
    resolveSecret(reference) {
      this.lookups.push(reference);
      const plaintext = resolved[reference];
      if (plaintext === undefined) {
        throw new Error(`test resolver has no value for ${reference}`);
      }
      return plaintext;
    },
  };
}

const plan = async (api: GitHubClient, declared: Declared) =>
  unwrap(
    await actionsSecretsSection.plan(
      planContext(actionsSecretsSection, api, REPO),
      validatedInput("actions_secrets", declared),
    ),
  );

/** Plan, then execute against the same client; a failed execution rethrows its error. */
async function apply(api: GitHubClient, declared: Declared, exec: ExecTools = tools()) {
  const planned = await plan(api, declared);
  const execution = await executePlan(planned, actionsSecretsSection, api, REPO, exec);
  if (execution.status === "failed") {
    throw new Error(execution.failure.message);
  }
  return { plan: planned, changes: execution.changes };
}

/** The sealed {encrypted_value, key_id} body a recorded PUT carried. */
function sealedPayload(call: { payload?: unknown } | undefined) {
  return call?.payload as { encrypted_value: string; key_id: string };
}

/** A stateful fake: the list reflects every PUT and DELETE, so a re-plan sees converged state. */
function liveRepo(names: string[]): GitHubClient & { writes: string[] } {
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      if (method === "GET" && path.endsWith("/public-key")) {
        return KEY_ROUTE;
      }
      if (method === "GET") {
        return listOf(...names);
      }
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (method === "PUT") {
        expect(unsealSecretValue(sealedPayload({ payload }).encrypted_value)).not.toBeNull();
        if (!names.includes(name)) {
          names.push(name);
        }
      } else if (method === "DELETE") {
        names.splice(names.indexOf(name), 1);
      }
      this.writes.push(`${method} ${path}`);
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the actions_secrets section issues no GraphQL");
    },
  };
}

describe("actions_secrets planning", () => {
  test("every declared secret plans a sealed PUT: the missing one carries its drift, the existing one none; ONE cannot-verify note", async () => {
    const api = new MockApi({ [LIST]: listOf("PRESENT"), [PUBLIC_KEY]: KEY_ROUTE });
    const result = await plan(api, [
      { name: "present", value: "$PRESENT_REF" },
      { name: "MISSING_ONE", value: "$REF_A" },
      { name: "MISSING_TWO", value: "$REF_B" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "put",
          params: { secret_name: "PRESENT" },
          payload: expect.any(Function),
          drift: [],
          change: 'updated secret "PRESENT"',
          describe: 'writing secret "PRESENT"',
        },
        {
          role: "put",
          params: { secret_name: "MISSING_ONE" },
          payload: expect.any(Function),
          drift: [
            "actions_secrets[MISSING_ONE]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created secret "MISSING_ONE"',
          describe: 'writing secret "MISSING_ONE"',
        },
        {
          role: "put",
          params: { secret_name: "MISSING_TWO" },
          payload: expect.any(Function),
          drift: [
            "actions_secrets[MISSING_TWO]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created secret "MISSING_TWO"',
          describe: 'writing secret "MISSING_TWO"',
        },
      ],
      notes: [CANNOT_VERIFY],
      drift: [],
    });
    // The sealing key is an execution-time read, so check mode issues the list alone.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/o/r/actions/secrets?per_page=100&page=1",
    ]);
  });

  test("the plan carries references, never values: a thunk seals its own entry's plaintext only when executed", async () => {
    await mockSodiumReady();
    const api = new MockApi({ [LIST]: listOf(), [PUBLIC_KEY]: KEY_ROUTE });
    const result = await plan(api, [
      { name: "A", value: "$A" },
      { name: "B", value: "$B" },
    ]);
    // Nothing at plan time could have resolved a reference: the resolver is first consulted when a thunk runs.
    const exec = tools({ $A: "value-a", $B: "value-b" });
    const payloads = await Promise.all(
      result.ops.map(async (op) =>
        typeof op.payload === "function"
          ? sealedPayload({ payload: unwrap(await op.payload(exec)) })
          : null,
      ),
    );
    // Both thunks share one key read, issued when the first ran.
    expect(api.calls.filter((c) => c.path.endsWith("/public-key")).length).toBe(1);
    expect(exec.lookups).toEqual(["$A", "$B"]);
    expect(payloads.map((p) => p?.key_id)).toEqual(["test-key-id", "test-key-id"]);
    expect(payloads.map((p) => unsealSecretValue(p?.encrypted_value ?? ""))).toEqual([
      "value-a",
      "value-b",
    ]);
  });

  test("an undeclared live secret is a keep-note by default, a planned DELETE under _undeclared: delete", async () => {
    const api = new MockApi({ [LIST]: listOf("STALE") });
    const kept = await plan(api, []);
    expect(kept).toEqual({
      ops: [],
      notes: [
        'Actions secret "STALE" exists on the repo but is not declared in the settings file; ' +
          'kept under "_undeclared: keep" - add it to the settings file to manage it, or set ' +
          '"_undeclared: delete" to have apply DELETE it (a deleted secret\'s value is ' +
          "unrecoverable)",
      ],
      drift: [],
    });

    const deleted = await plan(new MockApi({ [LIST]: listOf("STALE") }), {
      _undeclared: "delete",
      entries: [],
    });
    expect(deleted).toEqual({
      ops: [
        {
          role: "remove",
          params: { secret_name: "STALE" },
          drift: [
            'actions_secrets[STALE]: undeclared - not in the settings file and "_undeclared: delete" is set, so apply will DELETE it (the value is unrecoverable); add it to the settings file to keep it',
          ],
          change: 'DELETED undeclared secret "STALE"',
          describe: 'deleting undeclared secret "STALE"',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test("an empty declaration earns no cannot-verify note and never reads the sealing key", async () => {
    const api = new MockApi({ [LIST]: listOf() });
    expect(await plan(api, [])).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.calls.map((c) => c.path)).toEqual([
      "/repos/o/r/actions/secrets?per_page=100&page=1",
    ]);
  });

  test("case-insensitive duplicate names are a validate issue in both declared forms, so the document fails before any API call", () => {
    const entries = [
      { name: "token", value: "$A" },
      { name: "TOKEN", value: "$B" },
    ];
    const issue = {
      path: "[1].name",
      message:
        '"TOKEN" names the same secret as "token" declared earlier; keep exactly one entry per secret',
    };
    expect(actionsSecretsSection.validate(entries)).toEqual([issue]);
    expect(actionsSecretsSection.validate({ _undeclared: "delete", entries })).toEqual([
      { ...issue, path: ".entries[1].name" },
    ]);
  });

  // Reference validation lives in engine/secret-refs.ts (test/engine/secret-refs.test.ts); the section only extracts and looks up values.
});

describe("actions_secrets execution", () => {
  test("executing the plan seals and PUTs every declared secret: create and update, case-insensitively", async () => {
    await mockSodiumReady();
    const api = new MockApi({ [LIST]: listOf("EXISTING"), [PUBLIC_KEY]: KEY_ROUTE }).allowMutations(
      "PUT /repos/o/r/actions/secrets/EXISTING",
      "PUT /repos/o/r/actions/secrets/BRAND_NEW",
    );
    const { changes } = await apply(
      api,
      [
        { name: "existing", value: "$A" },
        { name: "BRAND_NEW", value: "$B" },
      ],
      tools({ $A: "value-a", $B: "value-b" }),
    );
    // Existence decides the verb: the live secret is an update, the other a create.
    expect(changes).toEqual(['updated secret "EXISTING"', 'created secret "BRAND_NEW"']);
    const puts = api.mutations().filter((call) => call.method === "PUT");
    expect(puts.map((call) => call.path)).toEqual([
      "/repos/o/r/actions/secrets/EXISTING",
      "/repos/o/r/actions/secrets/BRAND_NEW",
    ]);
    for (const [index, expected] of [
      [0, "value-a"],
      [1, "value-b"],
    ] as const) {
      const payload = sealedPayload(puts[index]);
      expect(Object.keys(payload).sort()).toEqual(["encrypted_value", "key_id"]);
      expect(payload.key_id).toBe("test-key-id");
      expect(unsealSecretValue(payload.encrypted_value)).toBe(expected);
    }
  });

  test("the sealed PUT recurs on every plan by declaration; the deletion converges, and a created secret is an update on the next plan with its missing drift gone", async () => {
    // No compare is possible (values cannot be read back), and the rewrite is what propagates a rotated source value, so the PUT fires on every pass.
    const api = liveRepo(["ROTATED", "STALE"]);
    const { first, second, changes } = await provePlanIdempotent(
      actionsSecretsSection,
      api,
      {
        _undeclared: "delete",
        entries: [
          { name: "rotated", value: "$R" },
          { name: "NEW", value: "$N" },
        ],
      },
      tools({ $R: "new-plaintext", $N: "n" }),
    );
    expect(changes).toEqual([
      'updated secret "ROTATED"',
      'created secret "NEW"',
      'DELETED undeclared secret "STALE"',
    ]);
    expect(first.ops.map((op) => op.role)).toEqual(["put", "put", "remove"]);
    expect(first.ops[1]?.drift).toEqual([expect.stringContaining("missing")]);
    expect(second.ops.map((op) => [op.role, op.drift, op.change])).toEqual([
      ["put", [], 'updated secret "ROTATED"'],
      ["put", [], 'updated secret "NEW"'],
    ]);
    // provePlanIdempotent executes the converged plan too, hence the second round of PUTs.
    expect(api.writes).toEqual([
      "PUT /repos/o/r/actions/secrets/ROTATED",
      "PUT /repos/o/r/actions/secrets/NEW",
      "DELETE /repos/o/r/actions/secrets/STALE",
      "PUT /repos/o/r/actions/secrets/ROTATED",
      "PUT /repos/o/r/actions/secrets/NEW",
    ]);
  });

  test("undeclared secrets: kept with a note by default, DELETED under the knob without a resolver", async () => {
    const api = new MockApi({ [LIST]: listOf("STALE"), [PUBLIC_KEY]: KEY_ROUTE });
    const kept = await apply(api, []);
    expect(kept.changes).toEqual([]);
    expect(kept.plan.notes.join("\n")).toContain("unrecoverable");
    expect(api.mutations()).toEqual([]);

    // Nothing declared means no references, so the engine provisions a resolver that refuses every lookup; deletion must never touch it, and nothing
    // needs sealing.
    const api2 = new MockApi({ [LIST]: listOf("STALE") }).allowMutations(
      "DELETE /repos/o/r/actions/secrets/STALE",
    );
    const exec = tools();
    const deleted = await apply(api2, { _undeclared: "delete", entries: [] }, exec);
    expect(deleted.changes).toEqual(['DELETED undeclared secret "STALE"']);
    expect(exec.lookups).toEqual([]);
    expect(api2.calls.some((call) => call.path.endsWith("/public-key"))).toBe(false);
  });

  test("a hostile resolved value appears nowhere: not in the plan, paths, or payload text", async () => {
    const hostile = 'ho"st\\ile\nvalue-with-%25-and-|pipes|';
    const fragment = "value-with-%25"; // a distinctive contiguous piece of it
    const api = new MockApi({ [LIST]: listOf(), [PUBLIC_KEY]: KEY_ROUTE }).allowMutations(
      "PUT /repos/o/r/actions/secrets/EDGY",
    );
    const { plan: planned, changes } = await apply(
      api,
      [{ name: "EDGY", value: "$H" }],
      tools({ $H: hostile }),
    );
    const rendered = [
      ...changes,
      ...planned.ops.flatMap(driftOf),
      ...planned.drift,
      ...planned.notes,
      ...api.calls.map((call) => call.path),
    ].join("\n");
    expect(rendered).not.toContain(hostile);
    expect(rendered).not.toContain(fragment);
    const put = api.mutations().find((call) => call.method === "PUT");
    expect(put?.path).toBe("/repos/o/r/actions/secrets/EDGY");
    const payload = sealedPayload(put);
    expect(payload.encrypted_value).not.toContain(fragment);
    expect(unsealSecretValue(payload.encrypted_value)).toBe(hostile);
  });

  test("a failing PUT fails the execution with the error withheld, whatever the client echoed", async () => {
    // The stub client echoes the plaintext the way a real 422 body can; the PUT reaches it marked as secret-carrying,
    // so the contract layer rebuilds the error before it renders.
    const api = new MockApi({
      [LIST]: listOf(),
      [PUBLIC_KEY]: KEY_ROUTE,
      "PUT /repos/o/r/actions/secrets/DENIED_WRITE": {
        error: { status: 422, message: "Validation Failed: super-plain is too weak", body: "" },
      },
    });
    const planned = await plan(api, [{ name: "DENIED_WRITE", value: "$V" }]);
    const execution = await executePlan(
      planned,
      actionsSecretsSection,
      api,
      REPO,
      tools({ $V: "super-plain" }),
    );
    expect(execution.status).toBe("failed");
    expect(api.mutations().map((call) => call.carriesSecret)).toEqual([true]);
    const message = execution.status === "failed" ? execution.failure.message : "";
    expect(message).toBe(
      `actions_secrets: writing secret "DENIED_WRITE" failed - PUT /repos/o/r/actions/secrets/DENIED_WRITE: 422 ${SECRET_RESPONSE_WITHHELD}. The API rejected the request; fix the "actions_secrets" values in the settings file to satisfy the message above`,
    );
  });

  test("a reference the engine never resolved fails inside the thunk, before its request", async () => {
    const api = new MockApi({ [LIST]: listOf(), [PUBLIC_KEY]: KEY_ROUTE }).allowMutations(
      "PUT /repos/o/r/actions/secrets/A",
    );
    await expect(apply(api, [{ name: "A", value: "$NEVER_RESOLVED" }], tools({}))).rejects.toThrow(
      /no value for \$NEVER_RESOLVED/,
    );
    expect(api.mutations()).toEqual([]);
  });

  test("the engine masks every plaintext before the first sealed PUT leaves the client", async () => {
    // The masks are registered after the read-only preflight and before the first mutation; test/engine holds the orchestrator's twin of this proof.
    const api = new MockApi({ [LIST]: listOf(), [PUBLIC_KEY]: KEY_ROUTE }).allowMutations(
      "PUT /repos/o/r/actions/secrets/DEPLOY_TOKEN",
    );
    const mutationsAtMaskTime: number[] = [];
    const { io, masks, logs, annotations } = captureIo(() =>
      mutationsAtMaskTime.push(api.mutations().length),
    );
    const validated = validateSettingsDoc(
      { actions_secrets: [{ name: "DEPLOY_TOKEN", value: "$DEPLOY_TOKEN" }] },
      "settings.yml",
      SectionSelection.ALL,
      io,
    );
    if (validated.isErr()) {
      throw new Error(describeProblem(validated.error));
    }
    const result = await runForRepo(
      api,
      {
        repo: REPO,
        settings: validated.value,
        mode: "apply",
        onMissingPermission: "fail",
        sections: SectionSelection.ALL,
        secretEnv: { DEPLOY_TOKEN: "s3cret-plaintext" },
      },
      io,
    );
    expect(result.result).toBe("applied");
    expect(masks).toEqual(["s3cret-plaintext"]);
    expect(mutationsAtMaskTime).toEqual([0]);
    expect(unsealSecretValue(sealedPayload(api.mutations()[0]).encrypted_value)).toBe(
      "s3cret-plaintext",
    );
    expect([...annotations, ...logs].join("\n")).not.toContain("s3cret-plaintext");
    expect(logs).toContain('actions_secrets: created secret "DEPLOY_TOKEN"');
  });
});

describe("actions_secrets sealing key", () => {
  test("an unusable public key fails the first PUT before its request leaves; check mode never reads the key", async () => {
    const api = new MockApi({ [LIST]: listOf(), [PUBLIC_KEY]: { data: { key: 42 } } });
    const planned = await plan(api, [{ name: "X", value: "$V" }]);
    expect(planned.ops.map((op) => op.role)).toEqual(["put"]);
    await expect(apply(api, [{ name: "X", value: "$V" }], tools({ $V: "v" }))).rejects.toThrow(
      /no usable \{key_id, key\} pair \(key_id is missing\)/,
    );
    expect(api.mutations()).toEqual([]);

    // GitHub requires key_id in the PUT body to route the ciphertext, so an empty one is as unusable as a missing one.
    const emptyId = new MockApi({
      [LIST]: listOf(),
      [PUBLIC_KEY]: { data: { key_id: "", key: MOCK_SECRETS_PUBLIC_KEY } },
    });
    await expect(apply(emptyId, [{ name: "X", value: "$V" }], tools({ $V: "v" }))).rejects.toThrow(
      /no usable \{key_id, key\} pair \(key_id is empty\)/,
    );
    expect(emptyId.mutations()).toEqual([]);
  });
});

describe("actions_secrets contract", () => {
  test("the read port exposes exactly the two reads, the list narrowed to its denied posture", () => {
    const ctx = planContext(actionsSecretsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read).sort()).toEqual(["list", "publicKey"]);
    // @ts-expect-error a write role is not a read: the port has no `put`
    ctx.read.put;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error nor the raw client
    ctx.api;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
    // @ts-expect-error nor the tolerant tryCall
    ctx.read.list.tryCall;
  });

  test("a planned operation names a declared write role; only the sealed PUT may go without drift", () => {
    // Compile-time only. Each rejected shape is built first and assigned on one line, so the @ts-expect-error anchors to the assignment whichever
    // property the compiler blames.
    type Op = PlannedOp<typeof actionsSecretsSection.endpoints>;
    const sealed: Op = {
      role: "put",
      params: { secret_name: "A" },
      payload: (exec) => ok({ encrypted_value: exec.resolveSecret("$A"), key_id: "k" }),
      // alwaysRewrite by declaration: no drift needed to justify the write.
      drift: [],
      change: "",
    };
    expect(sealed.role).toBe("put");
    const read = { role: "list", drift: ["x"], change: "" } as const;
    // @ts-expect-error the list role is a read, not a plannable write
    const _read: Op = read;
    const key = { role: "publicKey", drift: ["x"], change: "" } as const;
    // @ts-expect-error nor is the public-key read
    const _key: Op = key;
    const silentDelete = {
      role: "remove",
      params: { secret_name: "A" },
      drift: [],
      change: "",
    } as const;
    // @ts-expect-error the DELETE is not alwaysRewrite, so it must carry drift
    const _silentDelete: Op = silentDelete;
    const nameless = { role: "put", params: {}, drift: [], change: "" } as const;
    // @ts-expect-error the route's {secret_name} param is required
    const _nameless: Op = nameless;
  });
});
