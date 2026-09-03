/**
 * The idempotence helper's own controls, over synthetic plan sections
 * workflows cannot exercise: a write that is alwaysRewrite by declaration
 * and carries a payload THUNK (the shape the sealed secret sections migrate
 * into), and a section whose write is conditional but whose live read never
 * reflects it, so it re-plans forever. The helper must accept the first -
 * fresh closure per pass included - and reject the second.
 */

import { describe, expect, test } from "bun:test";
import { actionsSecretsSection } from "../../src/sections/actions_secrets/index.js";
import type { EndpointDecl } from "../../src/sections/contract/endpoints.js";
import type { SectionModule } from "../../src/sections/contract/module.js";
import type { ExecTools } from "../../src/sections/contract/plan.js";
import { MockApi } from "../mock-api.js";
import { provePlanIdempotent } from "./plan-idempotence.js";

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
 * compare against - and its value is sealed at execution time.
 */
const sealed = {
  ...META,
  endpoints: SEALED_ENDPOINTS,
  async plan(ctx, desired) {
    await ctx.read.list.listAllEnveloped("secrets");
    return {
      ops: entriesOf(desired).map((entry) => ({
        role: "put" as const,
        params: { secret_name: entry.name },
        // A fresh closure on every planning pass: the helper must compare
        // operation identity, not function references.
        payload: (exec: ExecTools) => ({ encrypted_value: exec.resolveSecret(entry.value) }),
        drift: [],
        change: `set secret "${entry.name}"`,
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

  test("a conditional write the live read never reflects fails the proof", async () => {
    await expect(provePlanIdempotent(stuck, client([]), DESIRED, TOOLS)).rejects.toThrow(
      /would not converge/,
    );
  });
});
