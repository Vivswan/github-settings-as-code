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
  test("the probe answers 200 and echoes the STORED spelling", () => {
    const response = get("environments.probe", "prod");
    expect(response.status).toBe(200);
    expect((response.body as { name: unknown }).name).toBe("Prod");
  });

  test("the branch-policy list carries the seeded pattern, not an empty list", () => {
    const response = get("environments.listPolicies", "prod");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total_count: 1,
      branch_policies: [{ name: "main", type: "branch" }],
    });
  });

  test("the variables list carries the seeded variable", () => {
    const response = get("environments.listVariables", "PROD");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total_count: 1,
      variables: [{ name: "REGION", value: "eu" }],
    });
  });

  test("an environment nobody seeded still 404s under every spelling", () => {
    expect(get("environments.probe", "staging").status).toBe(404);
    expect(get("environments.listPolicies", "Staging").status).toBe(404);
  });
});
