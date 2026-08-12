/**
 * The interaction_limits mock fragment the e2e route pipeline aggregates
 * (test/e2e/mock/sections.ts). Deliberately imports the test-tree seams
 * (support.ts and state.ts, never routes.ts); the bundle entry is
 * src/main.ts, so this file never reaches lib/index.js.
 */

import { bypassUser } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  bypassLogins,
  CAP_UNAVAILABLE_405,
  type Handler,
  INTERACTION_EXPIRES,
  INTERACTION_ORG_CONFLICT,
  INTERACTION_ORG_LIMIT,
  noContent,
  ok,
  sameLogin,
} from "../../../test/e2e/mock/support.js";

export const interactionLimitsMockHandlers: Record<string, Handler> = {
  "interaction_limits.get": ({ state }) =>
    // A literal empty object is GitHub's "no limit set" answer (the spec's
    // empty-object anyOf branch), never null or a 404. When the org-override
    // flag is set with no seeded limit, GitHub would report the org's limit,
    // so the mock derives one - an override with an empty GET is a live
    // state GitHub cannot produce.
    ok(
      state.interaction_limits ??
        (state.interaction_limits_org_override ? INTERACTION_ORG_LIMIT : {}),
    ),
  "interaction_limits.put": ({ state, body }) => {
    if (state.interaction_limits_org_override) {
      return INTERACTION_ORG_CONFLICT;
    }
    const payload = asObject(body);
    const expiry = typeof payload.expiry === "string" ? payload.expiry : "one_day";
    // GitHub stores limit/origin/expires_at only; the declared expiry
    // duration maps to a FIXED expires_at per value so repeat applies stay
    // byte-stable for the idempotence proof.
    state.interaction_limits = {
      limit: payload.limit,
      origin: "repository",
      expires_at: INTERACTION_EXPIRES[expiry] ?? INTERACTION_EXPIRES.one_day,
    };
    return ok(state.interaction_limits);
  },
  "interaction_limits.remove": ({ state }) => {
    if (state.interaction_limits_org_override) {
      return INTERACTION_ORG_CONFLICT;
    }
    state.interaction_limits = null;
    return noContent();
  },
  "interaction_limits.capGet": ({ state }) =>
    state.pull_creation_cap_unavailable ? CAP_UNAVAILABLE_405 : ok(state.pull_creation_cap),
  "interaction_limits.capPatch": ({ state, body }) => {
    if (state.pull_creation_cap_unavailable) {
      return CAP_UNAVAILABLE_405;
    }
    // The PATCH requires enabled and takes max_open_pull_requests optionally;
    // merging over the stored cap keeps the response's required max field.
    state.pull_creation_cap = { ...state.pull_creation_cap, ...asObject(body) };
    return ok(state.pull_creation_cap);
  },
  // The endpoint documents no pagination parameters, so the whole list is
  // served in one body, like GitHub.
  "interaction_limits.bypassList": ({ state }) => ok(state.pull_bypass_list),
  "interaction_limits.bypassAdd": ({ state, body }) => {
    // Adds the named logins to the list (case-insensitively deduped); never
    // a wholesale replace - the DELETE removes. The documented 100-user
    // total is enforced, so an add-before-remove regression 422s here.
    const additions = bypassLogins(body).filter(
      (login) => !state.pull_bypass_list.some((user) => sameLogin(user, login)),
    );
    if (state.pull_bypass_list.length + additions.length > 100) {
      return {
        status: 422,
        body: {
          message: "Validation Failed: the bypass list can only hold a maximum of 100 users",
        },
      };
    }
    for (const login of additions) {
      state.pull_bypass_list.push(bypassUser({ login }, state.nextId++));
    }
    return noContent();
  },
  "interaction_limits.bypassRemove": ({ state, body }) => {
    const logins = bypassLogins(body);
    state.pull_bypass_list = state.pull_bypass_list.filter(
      (user) => !logins.some((login) => sameLogin(user, login)),
    );
    return noContent();
  },
};
