/**
 * The action never PUTs the Pages config after a delete (an absent site takes the POST create path), so the update-after-delete contract is pinned
 * here, directly against the handler.
 */

import { describe, expect, test } from "bun:test";
import { handlerTestContext } from "../../../test/e2e/mock/handler-test-ctx.js";
import { buildStateForSlug, type MockState } from "../../../test/e2e/mock/state.js";
import { pagesMockHandlers } from "./mock.js";

// The fragment's exact key union makes a typo'd key a compile error, so no runtime not-found guard is needed.
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
    expect(state.pages).toBeNull();
  });

  test.each([
    ["pages.create", 201, null, { build_type: "workflow" }],
    ["pages.update", 204, { build_type: "workflow" }, { build_type: "legacy" }],
  ] as const)(
    "%s stores the body over the site, mints the url, and answers %d",
    (key, status, seeded, body) => {
      const state = slugged(seeded);
      const response = handler(key)(handlerTestContext(key, state, { body }));
      expect(response.status).toBe(status);
      expect(state.pages).toMatchObject({
        ...body,
        // The seeded site carried no url, so the handler completed it from the state slug (an existing stored url would win).
        url: "https://api.github.com/repos/acme/private/pages",
      });
    },
  );

  test("PUT stores only the update body's fields, so a key github.com ignores cannot fake convergence here", () => {
    // github.com drops `public` (Enterprise Cloud only) and every GET-only field from the update; an echoing mock hid that.
    const state = slugged({ build_type: "workflow", public: true, custom_404: false });
    const response = handler("pages.update")(
      handlerTestContext("pages.update", state, {
        body: { cname: "docs.example.com", public: false, custom_404: true, status: "built" },
      }),
    );
    expect(response.status).toBe(204);
    expect(state.pages).toEqual({
      url: "https://api.github.com/repos/acme/private/pages",
      build_type: "workflow",
      public: true,
      custom_404: false,
      cname: "docs.example.com",
    });
  });
});
