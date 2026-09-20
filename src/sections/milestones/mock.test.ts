/**
 * No scenario asserts on a served milestone number, so its minting is pinned here against the handler:
 * GitHub numbers milestones per repository from 1, never from the global id pool.
 */

import { describe, expect, test } from "bun:test";
import { handlerTestContext } from "../../../test/e2e/mock/handler-test-ctx.js";
import { buildStateForSlug, type MockState } from "../../../test/e2e/mock/state.js";
import { milestonesMockHandlers } from "./mock.js";

function create(state: MockState, body: Record<string, unknown>): Record<string, unknown> {
  const response = milestonesMockHandlers["milestones.create"](
    handlerTestContext("milestones.create", state, { body }),
  );
  expect(response.status).toBe(201);
  return response.body as Record<string, unknown>;
}

describe("milestones.create numbers per repository", () => {
  test("a created milestone takes the next number after the seeded ones, not its id", () => {
    // An unpinned seed numbers past the pinned one that follows it, so no two milestones share an address.
    const state = buildStateForSlug(
      "acme/widgets",
      {
        settingsYaml: null,
        liveState: { milestones: [{ title: "v1" }, { title: "v2", number: 7 }] },
      },
      "org",
    );
    expect(state.milestones.map((m) => m.number)).toEqual([8, 7]);
    expect(create(state, { title: "v3" }).number).toBe(9);
    expect(create(state, { title: "v4" }).number).toBe(10);
  });

  test("two repositories number independently", () => {
    const first = buildStateForSlug("acme/widgets", { settingsYaml: null }, "org");
    const second = buildStateForSlug("acme/gadgets", { settingsYaml: null }, "org");
    expect(create(first, { title: "v1" }).number).toBe(1);
    expect(create(second, { title: "v1" }).number).toBe(1);
  });

  test("an update keeps the number", () => {
    const state = buildStateForSlug(
      "acme/widgets",
      { settingsYaml: null, liveState: { milestones: [{ title: "v1" }] } },
      "org",
    );
    const response = milestonesMockHandlers["milestones.update"](
      handlerTestContext("milestones.update", state, {
        params: { milestone_number: "1" },
        body: { description: "first" },
      }),
    );
    expect(response.status).toBe(200);
    expect(state.milestones[0]).toMatchObject({ number: 1, description: "first" });
  });
});
