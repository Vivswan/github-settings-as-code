/**
 * Handler-level tests for the pages mock fragment: the GitHub-fidelity
 * behaviors the e2e engine flow cannot reach. The action never PUTs the
 * Pages config after a delete (an absent site takes the POST create path),
 * so the update-after-delete contract is pinned here, directly against the
 * handler.
 */

import { describe, expect, test } from "bun:test";
import { handlerTestContext } from "../../../test/e2e/mock/handler-test-ctx.js";
import { buildStateForSlug, type MockState } from "../../../test/e2e/mock/state.js";
import { pagesMockHandlers } from "./mock.js";

// The fragment's exact key union makes a typo'd key a compile error, so no
// runtime not-found guard is needed here.
function handler<K extends keyof typeof pagesMockHandlers>(key: K): (typeof pagesMockHandlers)[K] {
  return pagesMockHandlers[key];
}

function slugged(pages: Record<string, unknown> | null): MockState {
  return buildStateForSlug("acme/private", { settingsYaml: null, liveState: { pages } }, "org");
}

describe("pages mock handlers", () => {
  test("PUT on a deleted site answers 404 instead of resurrecting it", () => {
    const state = slugged({ build_type: "workflow" });
    expect(handler("pages.remove")(handlerTestContext("pages.remove", state)).status).toBe(204);
    expect(state.pages).toBeNull();

    const response = handler("pages.update")(
      handlerTestContext("pages.update", state, { body: { build_type: "legacy" } }),
    );
    expect(response.status).toBe(404);
    // The load-bearing half: the PUT must NOT have re-created the site.
    expect(state.pages).toBeNull();
  });

  test("PUT on an existing site merges the body, mints the url, and answers 204", () => {
    const state = slugged({ build_type: "workflow" });
    const response = handler("pages.update")(
      handlerTestContext("pages.update", state, { body: { build_type: "legacy" } }),
    );
    expect(response.status).toBe(204);
    expect(state.pages).toMatchObject({
      build_type: "legacy",
      // The seeded site carried no url, so the update completed it from the
      // state slug (an existing stored url would win, matching create).
      url: "https://api.github.com/repos/acme/private/pages",
    });
  });

  test("create mints the Pages url from the state slug", () => {
    const state = slugged(null);
    const response = handler("pages.create")(
      handlerTestContext("pages.create", state, { body: { build_type: "workflow" } }),
    );
    expect(response.status).toBe(201);
    expect(String((state.pages as Record<string, unknown>).url)).toBe(
      "https://api.github.com/repos/acme/private/pages",
    );
  });
});
