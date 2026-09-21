/**
 * GitHub matches an environment name case-insensitively and echoes the stored spelling, so a request
 * spelled "prod" over a seeded "Prod" reaches the environment AND everything keyed under it. The fold
 * lives once, at the handler entry; a lookup that folded the name but read a nested bucket raw would
 * answer 200 with an empty list, and no scenario would say why.
 */

import { describe, expect, test } from "bun:test";
import { handlerTestContext } from "../../../test/e2e/mock/handler-test-ctx.js";
import { buildState } from "../../../test/e2e/mock/state.js";
import type { SectionEndpointKey } from "../registry.js";
import { environmentsMockHandlers } from "./mock.js";

const state = buildState(
  {
    environments: {
      Prod: { name: "Prod", deployment_branch_policy: { custom_branch_policies: true } },
    },
    environment_branch_policies: { Prod: [{ id: 41, name: "main", type: "branch" }] },
    environment_variables: { Prod: [{ name: "REGION", value: "eu" }] },
  },
  "org",
);

function get(key: SectionEndpointKey<"environments">, environment_name: string) {
  return environmentsMockHandlers[key](
    handlerTestContext(key, state, {
      params: { owner: "e2e-owner", repo: "e2e-repo", environment_name },
    }),
  );
}

describe("a request spelled another way reaches the seeded environment and its buckets", () => {
  test.each([
    ["environments.probe", "prod", 200, { name: "Prod" }],
    [
      "environments.listPolicies",
      "prod",
      200,
      { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] },
    ],
    [
      "environments.listVariables",
      "PROD",
      200,
      { total_count: 1, variables: [{ name: "REGION", value: "eu" }] },
    ],
    ["environments.probe", "staging", 404, undefined],
    ["environments.listPolicies", "Staging", 404, undefined],
  ] as Array<[SectionEndpointKey<"environments">, string, number, object | undefined]>)(
    "%s spelled %s answers %i: the STORED spelling and the seeded bucket when one exists, 404 when nobody seeded it",
    (key, spelling, status, body) => {
      const response = get(key, spelling);
      expect(response.status).toBe(status);
      if (body !== undefined) {
        expect(response.body).toMatchObject(body);
      }
    },
  );
});
