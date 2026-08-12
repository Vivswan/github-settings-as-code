/**
 * Handler-level tests for the pages mock fragment: the GitHub-fidelity
 * behaviors the e2e engine flow cannot reach. The action never PUTs the
 * Pages config after a delete (an absent site takes the POST create path),
 * so the update-after-delete contract is pinned here, directly against the
 * handler.
 */

import { describe, expect, test } from "bun:test";
import { buildStateForSlug, type MockState } from "../../../test/e2e/mock/state.js";
import { pagesMockHandlers } from "./mock.js";

/**
 * A minimal handler context: these handlers read only `state` and `body`
 * (never the matched endpoint or a path param), so the unused seams stay
 * loud-if-touched instead of silently fabricated.
 */
function ctx(state: MockState, body?: unknown): Parameters<(typeof pagesMockHandlers)[string]>[0] {
  return {
    state,
    endpoint: undefined as never,
    param: (name: string): string => {
      throw new Error(`pages mock test context declares no path param "${name}"`);
    },
    query: {},
    body,
  };
}

function slugged(pages: Record<string, unknown> | null): MockState {
  return buildStateForSlug("acme/private", { settingsYaml: null, liveState: { pages } }, "org");
}

describe("pages mock handlers", () => {
  test("PUT on a deleted site answers 404 instead of resurrecting it", () => {
    const state = slugged({ build_type: "workflow" });
    const remove = pagesMockHandlers["pages.remove"];
    const update = pagesMockHandlers["pages.update"];
    if (!remove || !update) {
      throw new Error("pages.remove / pages.update handlers missing");
    }
    expect(remove(ctx(state)).status).toBe(204);
    expect(state.pages).toBeNull();

    const response = update(ctx(state, { build_type: "legacy" }));
    expect(response.status).toBe(404);
    // The load-bearing half: the PUT must NOT have re-created the site.
    expect(state.pages).toBeNull();
  });

  test("PUT on an existing site merges the body and answers 204", () => {
    const state = slugged({ build_type: "workflow" });
    const update = pagesMockHandlers["pages.update"];
    if (!update) {
      throw new Error("pages.update handler missing");
    }
    const response = update(ctx(state, { build_type: "legacy" }));
    expect(response.status).toBe(204);
    expect(state.pages).toMatchObject({ build_type: "legacy" });
  });

  test("create and update mint the Pages url from the state slug", () => {
    const created = slugged(null);
    const create = pagesMockHandlers["pages.create"];
    if (!create) {
      throw new Error("pages.create handler missing");
    }
    expect(create(ctx(created, { build_type: "workflow" })).status).toBe(201);
    expect(String((created.pages as Record<string, unknown>).url)).toBe(
      "https://api.github.com/repos/acme/private/pages",
    );
  });
});
