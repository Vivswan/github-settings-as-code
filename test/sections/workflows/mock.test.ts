import { describe, expect, test } from "bun:test";
import { ADMIN_OWNER as OWNER, ADMIN_REPO as REPO } from "../../e2e/constants.js";
import { call, json, mockServerLifecycle, scenario } from "../../e2e/mock/server-test-support.js";

const start = mockServerLifecycle();

describe("workflows envelope", () => {
  test("the list wraps in {total_count, workflows}", async () => {
    const h = await start(
      scenario({
        live_state: {
          workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
        },
      }),
    );
    const body = await json(await call(h, "GET", `/repos/${OWNER}/${REPO}/actions/workflows`));
    expect(body.total_count).toBe(1);
    expect(body.workflows).toHaveLength(1);
  });
});
