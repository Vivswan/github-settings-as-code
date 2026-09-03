/**
 * The idempotence helper's own controls, over synthetic plan sections
 * workflows cannot exercise: a write that is alwaysRewrite by declaration
 * and carries a payload THUNK (the shape the sealed secret sections migrate
 * into), and a section whose write is conditional but whose live read never
 * reflects it, so it re-plans forever. The helper must accept the first -
 * fresh closure per pass included - and reject the second.
 */

import { describe, expect, test } from "bun:test";
import type { GithubClient } from "../../src/github/api.js";
import { actionsSecretsSection } from "../../src/sections/actions_secrets/index.js";
import type { EndpointDecl } from "../../src/sections/contract/endpoints.js";
import type { SectionModule } from "../../src/sections/contract/module.js";
import type { ExecTools, PlannedOp } from "../../src/sections/contract/plan.js";
import { MockApi } from "../mock-api.js";
import { identityOf, provePlanIdempotent, requestOf } from "./plan-idempotence.js";

const LIST = {
  route: "GET /repos/{owner}/{repo}/actions/secrets",
  statuses: { 200: "the secrets" },
  primaryRead: { notFound: "denied" },
} as const satisfies EndpointDecl;

const PUT = {
  route: "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}",
  statuses: { 201: "created", 204: "updated" },
} as const satisfies EndpointDecl;

/** The two dictionaries differ in ONE declaration: whether the PUT recurs. */
const SEALED_ENDPOINTS = { list: LIST, put: { ...PUT, alwaysRewrite: true } } as const;
const CONDITIONAL_ENDPOINTS = { list: LIST, put: PUT } as const;

const META = {
  key: "actions_secrets",
  permission: { repo: ["secrets"] },
  undeclaredDefault: "keep",
  shape: actionsSecretsSection.shape,
} as const;

/** The declared entries, whichever form the knobbed section value takes. */
function entriesOf(declared: unknown): ReadonlyArray<{ name: string; value: string }> {
  return Array.isArray(declared)
    ? (declared as ReadonlyArray<{ name: string; value: string }>)
    : [];
}

/**
 * The sealed posture: the PUT recurs by declaration, so it plans on every
 * pass with no drift to report - GitHub cannot echo a secret back to
 * compare against - and its value is sealed at execution time. The change
 * line names the live state ("created" for a secret the list lacks,
 * "updated" after), so it differs between passes while the write recurs.
 */
const sealed = {
  ...META,
  endpoints: SEALED_ENDPOINTS,
  async plan(ctx, desired) {
    const live = (await ctx.read.list.listAllEnveloped("secrets")) as Array<{ name: string }>;
    return {
      ops: entriesOf(desired).map((entry) => ({
        role: "put" as const,
        params: { secret_name: entry.name },
        // A fresh closure on every planning pass: the helper must compare
        // operation identity, not function references.
        payload: (exec: ExecTools) => ({ encrypted_value: exec.resolveSecret(entry.value) }),
        drift: [],
        change: `${live.some((s) => s.name === entry.name) ? "updated" : "created"} secret "${entry.name}"`,
      })),
      notes: [],
      drift: [],
    };
  },
} satisfies SectionModule<"actions_secrets", typeof SEALED_ENDPOINTS>;

/**
 * The non-converging posture: a conditional write whose live read never
 * shows the result (the fake's list stays empty), so every pass re-plans a
 * drift-bearing write. This is what a section comparing the wrong live
 * field looks like, and the proof must reject it.
 */
const stuck = {
  ...META,
  endpoints: CONDITIONAL_ENDPOINTS,
  async plan(ctx, desired) {
    const live = (await ctx.read.list.listAllEnveloped("secrets")) as Array<{ name: string }>;
    return {
      ops: entriesOf(desired)
        .filter((entry) => !live.some((s) => s.name === entry.name))
        .map((entry) => ({
          role: "put" as const,
          params: { secret_name: entry.name },
          payload: { encrypted_value: "sealed" },
          drift: [`actions_secrets[${entry.name}]: missing`] as [string],
          change: `set secret "${entry.name}"`,
        })),
      notes: [],
      drift: [],
    };
  },
} satisfies SectionModule<"actions_secrets", typeof CONDITIONAL_ENDPOINTS>;

const DESIRED = [{ name: "DEPLOY_TOKEN", value: "$DEPLOY_TOKEN" }];
const TOOLS: ExecTools = { resolveSecret: () => "sealed" };

/** A client whose secrets list never reflects the PUTs it accepts. */
function client(secrets: Array<{ name: string }>): MockApi {
  return new MockApi({
    "GET /repos/o/r/actions/secrets?per_page=100&page=1": {
      data: { total_count: secrets.length, secrets },
    },
    "PUT /repos/o/r/actions/secrets/DEPLOY_TOKEN": { data: null },
  });
}

/** A stateful fake: the secrets list reflects every PUT it accepts; any other request is refused. */
function liveSecrets(): GithubClient {
  const secrets: Array<{ name: string }> = [];
  return {
    async tryRequest(method, path) {
      if (method === "GET" && path.startsWith("/repos/o/r/actions/secrets?")) {
        return { data: { total_count: secrets.length, secrets } };
      }
      const put = path.match(/^\/repos\/o\/r\/actions\/secrets\/([^/?]+)$/);
      if (method !== "PUT" || put === null) {
        return { error: { status: 404, message: `unexpected ${method} ${path}`, body: "" } };
      }
      const name = put[1] as string;
      if (!secrets.some((s) => s.name === name)) {
        secrets.push({ name });
      }
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the secrets sections issue no GraphQL");
    },
  };
}

describe("provePlanIdempotent", () => {
  test("an alwaysRewrite operation with a payload thunk recurs without failing the proof", async () => {
    const { first, second } = await provePlanIdempotent(
      sealed,
      client([{ name: "DEPLOY_TOKEN" }]),
      DESIRED,
      TOOLS,
    );
    expect(first.ops).toHaveLength(1);
    expect(second.ops).toHaveLength(1);
    // Each pass built its own thunk; the proof passes because it compares
    // operation identity, not function references.
    expect(typeof first.ops[0]?.payload).toBe("function");
    expect(first.ops[0]?.payload).not.toBe(second.ops[0]?.payload);
  });

  test("an alwaysRewrite operation recurs by role and params: a change line that moves from created to updated is the same write", async () => {
    const { first, second, changes } = await provePlanIdempotent(
      sealed,
      liveSecrets(),
      DESIRED,
      TOOLS,
    );
    expect(changes).toEqual(['created secret "DEPLOY_TOKEN"']);
    expect(first.ops[0]?.change).toBe('created secret "DEPLOY_TOKEN"');
    expect(second.ops[0]?.change).toBe('updated secret "DEPLOY_TOKEN"');
  });

  test("an alwaysRewrite operation whose request changes between passes fails the proof", async () => {
    // The write recurs, but not the SAME write: a payload that differs on
    // the second pass is a section deriving request data from state it
    // should not see, so the role-and-params match alone must not pass it.
    let pass = 0;
    const drifting = {
      ...sealed,
      async plan(ctx, desired) {
        const plan = await sealed.plan(ctx, desired);
        pass++;
        return {
          ...plan,
          ops: plan.ops.map((op) => ({ ...op, payload: { encrypted_value: `pass ${pass}` } })),
        };
      },
    } satisfies SectionModule<"actions_secrets", typeof SEALED_ENDPOINTS>;
    await expect(
      provePlanIdempotent(drifting, client([{ name: "DEPLOY_TOKEN" }]), DESIRED, TOOLS),
    ).rejects.toThrow(/missing from the second/);
  });

  test("a conditional write the live read never reflects fails the proof", async () => {
    await expect(provePlanIdempotent(stuck, client([]), DESIRED, TOOLS)).rejects.toThrow(
      /would not converge/,
    );
  });
});

describe("identityOf", () => {
  const TOLERANT = {
    list: LIST,
    put: { ...PUT, statuses: { 201: "created", 204: "updated", 409: "busy", 422: "rejected" } },
  } as const;
  type Op = PlannedOp<typeof TOLERANT>;
  const base: Op = {
    role: "put",
    params: { secret_name: "A" },
    payload: { encrypted_value: "x" },
    drift: ["missing"],
    change: "set A",
    describe: "setting A",
  };

  test("folds every thunk to a marker and compares the remaining facets", () => {
    const rebuilt: Op = {
      ...base,
      payload: () => ({ encrypted_value: "x" }),
      change: () => "set A",
      capture: () => {},
      tolerate: { statuses: [409], outcome: () => ({ note: "" }) },
    };
    const again: Op = {
      ...rebuilt,
      payload: () => ({ encrypted_value: "y" }),
      change: () => "set B",
      capture: () => {},
      tolerate: { statuses: [409], outcome: () => ({ failure: "" }) },
    };
    expect(identityOf(rebuilt)).toEqual(identityOf(again));
    expect(identityOf(rebuilt)).not.toEqual(identityOf(base));
    // No literal can spell the marker: a change line reading like one is
    // still a string, not a thunk.
    const spelled: Op = { ...base, change: "<sealed>" };
    const thunk: Op = { ...base, change: () => "<sealed>" };
    expect(identityOf(spelled)).not.toEqual(identityOf(thunk));
  });

  test.each<[facet: string, changed: Op]>([
    ["describe", { ...base, describe: "arming A" }],
    ["params", { ...base, params: { secret_name: "B" } }],
    ["drift", { ...base, drift: ["stale"] }],
    ["a string change", { ...base, change: "set B" }],
    ["capture presence", { ...base, capture: () => {} }],
    [
      "tolerated statuses",
      { ...base, tolerate: { statuses: [422], outcome: () => ({ note: "" }) } },
    ],
  ])("a differing %s changes the identity", (_facet, changed) => {
    expect(identityOf(changed)).not.toEqual(identityOf(base));
  });

  test("requestOf keeps the request facets and drops the rendering ones", () => {
    const rendered: Op = {
      ...base,
      drift: ["other"],
      change: "other",
      describe: "other",
      capture: () => {},
    };
    expect(requestOf(rendered)).toEqual(requestOf(base));
    expect(requestOf({ ...base, query: { ref: "main" } })).not.toEqual(requestOf(base));
    expect(requestOf({ ...base, payload: { encrypted_value: "y" } })).not.toEqual(requestOf(base));
  });
});
