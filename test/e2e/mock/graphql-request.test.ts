/**
 * The pipeline answers a GraphQL request GitHub's schema refuses the way GitHub does, with errors and no data, ahead
 * of every handler, and fails the run. Without it the mock stores what GitHub would have refused and every scenario
 * passes on it. Pinned over the wire, since a handler unit test bypasses the pipeline.
 */

import { describe, expect, test } from "bun:test";
import { allGraphqlOps } from "../../../src/sections/registry.js";
import { ADMIN_SLUG, ADMIN_OWNER as OWNER, ADMIN_REPO as REPO } from "../constants.js";
import { sharedValidator } from "../openapi/validate.js";
import { mintNodeId } from "./node-id.js";
import { call, json, mockServerLifecycle, scenario, singleState } from "./server-test-support.js";

const start = mockServerLifecycle();
const OPS = allGraphqlOps();
const RULE_ID = mintNodeId("rule", ADMIN_SLUG, "release/*");
const ENVIRONMENT_ID = mintNodeId("environment", ADMIN_SLUG, "prod");

/** One wildcard rule and one pinned environment, so a handler that ran would have something to change. */
function seeded() {
  return scenario({
    live_state: {
      branch_protection_rules: [{ pattern: "release/*", isAdminEnforced: false }],
      environments: { prod: { name: "prod", protection_rules: [] } },
      pinned_environments: ["prod"],
    },
  });
}

describe("a request GitHub's schema refuses is answered with errors and no data, and fails the run", () => {
  test.each([
    {
      name: "an input field the schema lacks (the REST key on a rule mutation)",
      op: OPS["branches.updateRule"],
      variables: { input: { branchProtectionRuleId: RULE_ID, enforce_admins: true } },
      refusal: 'not to include unknown field "enforce_admins"',
    },
    {
      // Unrefused, the pin handler reads a null as "unpin" and drops the pin.
      name: "null for a variable the operation declares Boolean!",
      op: OPS["environments.pin"],
      variables: { environmentId: ENVIRONMENT_ID, pinned: null },
      refusal: 'Variable "$pinned" has invalid value: Expected value of non-null type "Boolean!"',
    },
    {
      name: "a document selecting a field the schema lacks",
      op: {
        ...OPS["branches.repoLookup"],
        query:
          "query BranchProtectionRepository($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { id nodeId } }",
      },
      variables: { owner: OWNER, repo: REPO },
      refusal: 'Cannot query field "nodeId" on type "Repository"',
    },
    {
      name: "a document that does not parse",
      op: { ...OPS["branches.repoLookup"], query: "query BranchProtectionRepository {" },
      variables: { owner: OWNER, repo: REPO },
      refusal: "Syntax Error: Expected Name, found <EOF>",
    },
  ])("$name stores nothing", async ({ op, variables, refusal }) => {
    const h = await start(seeded());
    const before = structuredClone(singleState(h));
    const res = await call(h, "POST", "/graphql", {
      body: { query: op.query, operationName: op.name, variables },
    });
    expect(res.status).toBe(200);
    // The whole body: GitHub sends no `data` key beside a request error.
    expect(await json(res)).toEqual({
      errors: [expect.objectContaining({ message: expect.stringContaining(refusal) })],
    });
    expect(singleState(h)).toEqual(before);
    expect(h.violations).toEqual([
      expect.stringContaining(`GraphQL ${op.name} is refused by GitHub's schema: `),
    ]);
    expect(h.violations[0]).toContain(refusal);
    // The violation above is the one report: the contract validator must not add its own for the untyped errors.
    expect(sharedValidator().validateLog(h.requests)).toEqual([]);
  });
});

test("control: a request on the schema is answered by its handler, with data and no violation", async () => {
  const h = await start(seeded());
  const op = OPS["environments.pin"];
  const res = await call(h, "POST", "/graphql", {
    body: {
      query: op.query,
      operationName: op.name,
      variables: { environmentId: ENVIRONMENT_ID, pinned: false },
    },
  });
  expect(res.status).toBe(200);
  expect(await json(res)).toEqual({
    data: { pinEnvironment: { environment: { name: "prod", isPinned: false } } },
  });
  expect(singleState(h).pinned_environments).toEqual([]);
  expect(h.violations).toEqual([]);
});
