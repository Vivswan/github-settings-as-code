import { describe, expect, test } from "bun:test";
import { ADMIN_OWNER as OWNER, ADMIN_REPO as REPO } from "../../e2e/constants.js";
import { call, mockServerLifecycle, scenario } from "../../e2e/mock/server-test-support.js";

const start = mockServerLifecycle();

describe("actions selected-actions 409", () => {
  test.each([
    [
      "409 when the policy is not 'selected'",
      { actions_permissions: { allowed_actions: "all" } },
      409,
    ],
    [
      "200 when the policy is 'selected'",
      {
        actions_permissions: { allowed_actions: "selected" },
        selected_actions: { github_owned_allowed: true },
      },
      200,
    ],
  ] as const)("GET selected-actions answers %s", async (_name, live_state, status) => {
    const h = await start(scenario({ live_state }));
    const res = await call(
      h,
      "GET",
      `/repos/${OWNER}/${REPO}/actions/permissions/selected-actions`,
    );
    expect(res.status).toBe(status);
  });
});
