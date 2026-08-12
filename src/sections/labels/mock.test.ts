/**
 * Handler-level tests for the labels mock fragment: identity minting rules
 * the e2e assertions do not read directly (no scenario asserts on a served
 * node_id or url), pinned here against the handler.
 */

import { describe, expect, test } from "bun:test";
import { handlerTestContext } from "../../../test/e2e/mock/handler-test-ctx.js";
import { buildStateForSlug, type MockState } from "../../../test/e2e/mock/state.js";
import { labelsMockHandlers } from "./mock.js";

function create(state: MockState, body: Record<string, unknown>): Record<string, unknown> {
  const handler = labelsMockHandlers["labels.create"];
  if (!handler) {
    throw new Error("labels mock fragment declares no create handler");
  }
  const response = handler(handlerTestContext("labels.create", state, { body }));
  expect(response.status).toBe(201);
  return response.body as Record<string, unknown>;
}

describe("labels.create identity minting", () => {
  test("node_id encodes the label's OWN id, matching the generateLabels pattern", () => {
    // Seed the state through the generate sugar so the created label's ids
    // come from the same monotonic pool as the seeded ones: the old
    // post-increment bug (id used, node_id encoding id+1) collided a created
    // label's node_id with the NEXT id in that shared pool.
    const state = buildStateForSlug(
      "acme/private",
      {
        settingsYaml: null,
        liveState: { labels: { generate: { count: 2, prefix: "area", color: "abcdef" } } },
      },
      "org",
    );
    create(state, { name: "bug", color: "d73a4a" });
    create(state, { name: "docs", color: "0075ca" });
    for (const label of state.labels) {
      const body = label as Record<string, unknown>;
      expect(body.node_id).toBe(`MDU6TGFiZWw${body.id}`);
    }
    // No two labels (seeded or created) share a node_id.
    const nodeIds = state.labels.map((label) => (label as Record<string, unknown>).node_id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });

  test("the created label's url names the state slug", () => {
    const state = buildStateForSlug("acme/private", { settingsYaml: null }, "org");
    const body = create(state, { name: "bug", color: "d73a4a" });
    expect(body.url).toBe("https://api.github.com/repos/acme/private/labels/bug");
  });
});
