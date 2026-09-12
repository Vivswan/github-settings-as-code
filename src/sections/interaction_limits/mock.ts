/**
 * The interaction_limits e2e mock fragment (aggregated in test/e2e/mock/sections.ts). It imports the
 * test-tree seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { bypassUser } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  bypassLogins,
  CAP_UNAVAILABLE_405,
  INTERACTION_EXPIRES,
  INTERACTION_ORG_CONFLICT,
  INTERACTION_ORG_LIMIT,
  noContent,
  ok,
  type SectionRestHandlers,
  sameLogin,
} from "../../../test/e2e/mock/support.js";

export const interactionLimitsMockHandlers: SectionRestHandlers<"interaction_limits"> = {
  "interaction_limits.get": ({ state }) =>
    // A literal empty object is GitHub's "no limit set" answer, never null or a 404. An org override
    // with no seeded limit derives the org's limit: an override with an empty GET is a live state
    // GitHub cannot produce.
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
    // GitHub stores limit/origin/expires_at only; the declared expiry maps to a FIXED expires_at per
    // value so repeat applies stay byte-stable for the idempotence proof.
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
    // max_open_pull_requests is optional on the PATCH but required on the response, so the body merges over the stored cap.
    state.pull_creation_cap = { ...state.pull_creation_cap, ...asObject(body) };
    return ok(state.pull_creation_cap);
  },
  // The endpoint documents no pagination parameters, so the whole list is served in one body, like GitHub.
  "interaction_limits.bypassList": ({ state }) => ok(state.pull_bypass_list),
  "interaction_limits.bypassAdd": ({ state, body }) => {
    // Adds are deduped case-insensitively against the stored list and are never a wholesale replace
    // (the DELETE removes). The documented 100-user total is enforced, so an add-before-remove regression 422s here.
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
