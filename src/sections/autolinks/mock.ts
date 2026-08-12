/**
 * The autolinks section's e2e mock fragment: one handler per
 * "autolinks.<role>" key in the section's ENDPOINTS, registered in
 * test/e2e/mock/sections.ts. Imports only the leaf seams (mock/support.ts,
 * mock/state.ts) - never routes.ts or sections.ts; the bundle entry is
 * src/main.ts, so this fragment never reaches lib/index.js.
 */

import {
  asObject,
  type Json,
  noContent,
  ok,
  type SectionRestHandlers,
} from "../../../test/e2e/mock/support.js";

export const autolinksMockHandlers: SectionRestHandlers<"autolinks"> = {
  "autolinks.list": ({ state }) => ok(state.autolinks), // section GETs unpaginated
  "autolinks.create": ({ state, body }) => {
    const payload = asObject(body);
    const autolink: Json = {
      id: state.nextId++,
      is_alphanumeric: true,
      ...payload,
    };
    state.autolinks.push(autolink);
    return { status: 201, body: autolink };
  },
  "autolinks.remove": ({ state, param }) => {
    const id = param("autolink_id");
    const index = state.autolinks.findIndex((a) => String(a.id) === id);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.autolinks.splice(index, 1);
    return noContent();
  },
};
