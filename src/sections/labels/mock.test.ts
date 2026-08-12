/**
 * Handler-level tests for the labels mock fragment: identity minting rules
 * the e2e assertions do not read directly (no scenario asserts on a served
 * node_id or url), pinned here against the handler.
 */

import { describe, expect, test } from "bun:test";
import { buildStateForSlug, type MockState } from "../../../test/e2e/mock/state.js";
import { labelsMockHandlers } from "./mock.js";

/** A minimal handler context: labels.create reads only `state` and `body`. */
function ctx(state: MockState, body: unknown): Parameters<(typeof labelsMockHandlers)[string]>[0] {
  return {
    state,
    endpoint: undefined as never,
    param: (name: string): string => {
      throw new Error(`labels mock test context declares no path param "${name}"`);
    },
    query: {},
    body,
  };
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
    const create = labelsMockHandlers["labels.create"];
    if (!create) {
      throw new Error("labels.create handler missing");
    }
    const first = create(ctx(state, { name: "bug", color: "d73a4a" })).body as Record<
      string,
      unknown
    >;
    const second = create(ctx(state, { name: "docs", color: "0075ca" })).body as Record<
      string,
      unknown
    >;
    for (const label of [...state.labels, first, second]) {
      const body = label as Record<string, unknown>;
      expect(body.node_id).toBe(`MDU6TGFiZWw${body.id}`);
    }
    // No two labels (seeded or created) share a node_id.
    const nodeIds = state.labels.map((label) => (label as Record<string, unknown>).node_id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });

  test("the created label's url names the state slug", () => {
    const state = buildStateForSlug("acme/private", { settingsYaml: null }, "org");
    const create = labelsMockHandlers["labels.create"];
    if (!create) {
      throw new Error("labels.create handler missing");
    }
    const body = create(ctx(state, { name: "bug", color: "d73a4a" })).body as Record<
      string,
      unknown
    >;
    expect(body.url).toBe("https://api.github.com/repos/acme/private/labels/bug");
  });
});
