/**
 * The pages e2e mock fragment (registered in test/e2e/mock/sections.ts). It imports the test-tree
 * seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import {
  asObject,
  noContent,
  ok,
  pagesUrl,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

export const pagesMockHandlers: SectionRestHandlers<"pages"> = {
  "pages.get": ({ state }) => {
    if (state.pages === null) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok(state.pages);
  },
  "pages.create": ({ state, body }) => {
    if (state.pages !== null) {
      // 409 is not declared for the create, so a conflict here is a scenario setup error; the 422
      // fails loudly rather than faking a 201.
      return { status: 422, body: { message: "Pages is already enabled" } };
    }
    state.pages = { url: pagesUrl(state.slug), ...asObject(body) };
    return { status: 201, body: state.pages };
  },
  "pages.update": ({ state, body }) => {
    // GitHub's PUT updates an EXISTING site only and answers 404 with Pages disabled, so an engine
    // regression that PUTs after a delete cannot silently resurrect the site here.
    if (state.pages === null) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.pages = { url: pagesUrl(state.slug), ...state.pages, ...asObject(body) };
    return noContent();
  },
  "pages.remove": ({ state }) => {
    state.pages = null;
    return noContent();
  },
};
