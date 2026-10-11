/**
 * No scenario observes the list's bypass_actors omission or the write-grade `[]` fill off the wire, so both are pinned here against the handler.
 */

import { describe, expect, test } from "bun:test";
import { handlerTestContext } from "../../e2e/mock/handler-test-ctx.js";
import { buildStateForSlug } from "../../e2e/mock/state.js";
import { rulesetsMockHandlers } from "./mock.js";

describe("rulesets bypass_actors visibility", () => {
  const seeded = {
    id: 42,
    name: "main",
    source_type: "Repository",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
  };
  const state = () =>
    buildStateForSlug(
      "acme/repo",
      { settingsYaml: null, liveState: { rulesets: [seeded] } },
      "org",
    );
  const { bypass_actors: _hidden, ...withoutBypass } = seeded;

  test("the list never carries bypass_actors, whatever the grade", () => {
    const response = rulesetsMockHandlers["rulesets.list"](
      handlerTestContext("rulesets.list", state(), { query: {}, grade: "write" }),
    );
    expect(response).toEqual({ status: 200, body: [withoutBypass] });
  });

  test("a ruleset stored without the key reads bypass_actors: [] at write grade, like GitHub", () => {
    // Otherwise an admin declaring a non-empty list against such a ruleset would see the hidden-key notice instead of the genuine drift.
    const bare = buildStateForSlug(
      "acme/repo",
      { settingsYaml: null, liveState: { rulesets: [withoutBypass] } },
      "org",
    );
    const response = rulesetsMockHandlers["rulesets.get"](
      handlerTestContext("rulesets.get", bare, { params: { ruleset_id: "42" }, grade: "write" }),
    );
    expect(response).toEqual({ status: 200, body: { ...withoutBypass, bypass_actors: [] } });
  });
});
