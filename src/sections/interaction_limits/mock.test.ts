/**
 * The bypass PUT's set semantics: the section never sends a repeated login (its schema rejects one), so no
 * scenario reaches this; it is pinned here so the mock keeps GitHub's store-once answer for a client that does.
 */

import { describe, expect, test } from "bun:test";
import { handlerTestContext } from "../../../test/e2e/mock/handler-test-ctx.js";
import { buildStateForSlug, type MockState } from "../../../test/e2e/mock/state.js";
import { interactionLimitsMockHandlers } from "./mock.js";

function stateWith(logins: string[]): MockState {
  return buildStateForSlug(
    "acme/widgets",
    { settingsYaml: null, liveState: { pull_bypass_list: logins.map((login) => ({ login })) } },
    "org",
  );
}

function add(state: MockState, users: string[]) {
  return interactionLimitsMockHandlers["interaction_limits.bypassAdd"](
    handlerTestContext("interaction_limits.bypassAdd", state, { body: { users } }),
  );
}

describe("interaction_limits.bypassAdd stores each login once", () => {
  test("a body repeating a login, in any casing, lands it once under its first spelling", () => {
    const state = stateWith(["keeper"]);
    expect(add(state, ["Alice", "alice", "ALICE", "KEEPER", "bob", "bob"])).toEqual({
      status: 204,
      body: null,
    });
    expect(state.pull_bypass_list.map((user) => user.login)).toEqual(["keeper", "Alice", "bob"]);
  });

  test("repeats do not count toward the 100-user cap", () => {
    const state = stateWith(Array.from({ length: 99 }, (_, i) => `user-${i}`));
    expect(add(state, ["newcomer", "Newcomer"]).status).toBe(204);
    expect(state.pull_bypass_list).toHaveLength(100);
  });
});
