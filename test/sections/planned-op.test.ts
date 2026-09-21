/**
 * The PlannedOp contract against one literal declaration, so no section test has to restate it: a plan
 * names a declared write role and nothing else, justifies a write with drift unless the declaration says
 * it recurs (alwaysRewrite) or cannot be read back (unverifiable), carries exactly its route's path params
 * or its mutation's variables, and tolerates only declared statuses. Compile-time pins; the erased view
 * the engine executes (driftOf, the justification forms) is pinned in test/engine/execute.test.ts.
 */

import { describe, test } from "bun:test";
import { graphqlOp } from "../../src/sections/contract/graphql.js";
import type { SectionMeta } from "../../src/sections/contract/module.js";
import type { PlannedOp } from "../../src/sections/contract/plan.js";

const DECL = {
  key: "labels",
  permission: { repo: ["administration"] },
  undeclaredDefault: "delete",
  endpoints: {
    list: { route: "GET /repos/{owner}/{repo}/labels", statuses: { 200: "the labels" } },
    create: {
      route: "POST /repos/{owner}/{repo}/labels",
      statuses: { 201: "label created", 422: "label refused" },
    },
    update: {
      route: "PATCH /repos/{owner}/{repo}/labels/{name}",
      statuses: { 200: "label updated", 404: "no such label" },
    },
    rearm: {
      route: "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}",
      statuses: { 204: "secret re-sealed" },
      alwaysRewrite: true,
    },
    seal: {
      route: "PATCH /repos/{owner}/{repo}/hooks/{hook_id}",
      statuses: { 200: "hook secret set" },
      unverifiable: true,
    },
  },
  graphql: {
    probe: graphqlOp<{ owner: string; repo: string }>()({
      name: "OpProbe",
      kind: "read",
      query: "query OpProbe($owner: String!, $repo: String!) { repository { id } }",
      outcomes: { ok: "the repository" },
    }),
    pin: graphqlOp<{ id: string; pinned: boolean }>()({
      name: "OpPin",
      kind: "write",
      query:
        "mutation OpPin($id: ID!, $pinned: Boolean!) { pin(input: { id: $id, pinned: $pinned }) { id } }",
      outcomes: { ok: "pinned" },
    }),
  },
} as const satisfies SectionMeta;

type Op = PlannedOp<typeof DECL.endpoints, typeof DECL.graphql>;

// Each rejected shape is built first and assigned on one line, so the directive anchors to the assignment whichever property the compiler blames.
describe("a planned operation", () => {
  test("names a declared write role of its own section, REST or GraphQL, and nothing else", () => {
    const read = { role: "list", drift: ["x"], change: "" } as const;
    // @ts-expect-error a GET is a read, not a plannable write
    const _read: Op = read;
    const query = {
      role: "probe",
      variables: { owner: "o", repo: "r" },
      drift: ["x"],
      change: "",
    } as const;
    // @ts-expect-error a GraphQL query is a read, not a plannable mutation
    const _query: Op = query;
    const undeclared = { role: "typo", drift: ["x"], change: "" } as const;
    // @ts-expect-error a role the section never declared
    const _undeclared: Op = undeclared;
    const mutation = {
      role: "pin",
      variables: { id: "E", pinned: true },
      drift: ["x"],
      change: "",
    } as const;
    // @ts-expect-error a REST-only Op type refuses the mutation, so a forgotten GraphQL dictionary fails loudly instead of widening
    const _restOnly: PlannedOp<typeof DECL.endpoints> = mutation;
    const _mutation: Op = mutation;
    const _create: Op = { role: "create", payload: { name: "bug" }, drift: ["x"], change: "" };
  });

  test("justifies itself with drift unless the declaration says the write recurs or cannot be read back", () => {
    const silent = { role: "create", drift: [], change: "" } as const;
    // @ts-expect-error a plain write must carry at least one drift line
    const _silent: Op = silent;
    const silentMutation = {
      role: "pin",
      variables: { id: "E", pinned: true },
      drift: [],
      change: "",
    } as const;
    // @ts-expect-error a GraphQL mutation always carries drift: none writes a value it cannot read back
    const _silentMutation: Op = silentMutation;
    const facetOnPlain = {
      role: "create",
      drift: { unverifiable: "the value never reads back", lines: [] },
      change: "",
    } as const;
    // @ts-expect-error the unverifiable facet is admitted only where the declaration says so
    const _facetOnPlain: Op = facetOnPlain;
    const _rearm: Op = { role: "rearm", params: { secret_name: "S" }, drift: [], change: "sealed" };
    const _sealed: Op = {
      role: "seal",
      params: { hook_id: "1" },
      drift: { unverifiable: "the value never reads back", lines: [] },
      change: "sealed",
    };
  });

  test("carries exactly its route's path params or its mutation's variables, and tolerates only declared statuses", () => {
    const missing = { role: "update", drift: ["x"], change: "" } as const;
    // @ts-expect-error the route names {name}, so params is required
    const _missing: Op = missing;
    const extra = { role: "create", params: { name: "bug" }, drift: ["x"], change: "" } as const;
    // @ts-expect-error the route has no path params beyond owner/repo
    const _extra: Op = extra;
    const emptyOnPlain = { role: "create", params: {}, drift: ["x"], change: "" } as const;
    // @ts-expect-error nor does an empty record stand in for none
    const _emptyOnPlain: Op = emptyOnPlain;
    const emptyOnParametrized = { role: "update", params: {}, drift: ["x"], change: "" } as const;
    // @ts-expect-error the route names {name}, so an empty record leaves it out
    const _emptyOnParametrized: Op = emptyOnParametrized;
    const restVariables = {
      role: "create",
      variables: { id: "E" },
      drift: ["x"],
      change: "",
    } as const;
    // @ts-expect-error a REST op carries params, never variables
    const _restVariables: Op = restVariables;
    const partial = { role: "pin", variables: { id: "E" }, drift: ["x"], change: "" } as const;
    // @ts-expect-error the mutation declares {id, pinned}
    const _partial: Op = partial;
    const mistyped = {
      role: "pin",
      variables: { id: "E", pinned: "yes" },
      drift: ["x"],
      change: "",
    } as const;
    // @ts-expect-error pinned is a boolean, so a string value does not compile
    const _mistyped: Op = mistyped;
    const undeclaredStatus = {
      role: "update",
      params: { name: "bug" },
      drift: ["x"],
      change: "",
      tolerate: { statuses: [409], outcome: () => ({ note: "" }) },
    } as const;
    // @ts-expect-error 409 is not a declared status of the PATCH, so it cannot be tolerated
    const _undeclaredStatus: Op = undeclaredStatus;
    const _tolerated: Op = {
      role: "update",
      params: { name: "bug" },
      drift: ["x"],
      change: "",
      tolerate: { statuses: [404], outcome: () => ({ note: "gone before the update" }) },
    };
  });
});
