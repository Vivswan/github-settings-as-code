/**
 * The pages section's e2e mock fragment: one handler per "pages.<role>" key
 * in the section's ENDPOINTS, registered in test/e2e/mock/sections.ts.
 * Imports only the leaf seam (mock/support.ts) - never
 * routes.ts or sections.ts; the bundle entry is src/main.ts, so this
 * fragment never reaches lib/index.js.
 */

import { asObject, type Handler, noContent, ok, pagesUrl } from "../../../test/e2e/mock/support.js";

export const pagesMockHandlers: Record<string, Handler> = {
  "pages.get": ({ state }) => {
    if (state.pages === null) {
      return { status: 404, body: { message: "Not Found" } };
    }
    return ok(state.pages);
  },
  "pages.create": ({ state, body }) => {
    if (state.pages !== null) {
      // POST creates; an existing site is a conflict. 409 is not declared for
      // this endpoint (create only declares 201), so a real conflict here
      // would be a scenario setup error; surface it loudly as a 422 the client
      // will classify as a hard failure rather than fake a 201.
      return { status: 422, body: { message: "Pages is already enabled" } };
    }
    state.pages = { url: pagesUrl(state.slug), ...asObject(body) };
    return { status: 201, body: state.pages };
  },
  "pages.update": ({ state, body }) => {
    // GitHub's PUT updates an EXISTING site only: with Pages disabled it
    // answers 404 instead of creating one. Mirrored here so an engine
    // regression that PUTs after a delete cannot silently resurrect the site
    // in the mock's state.
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
