/**
 * The stored hook keeps its REAL config.secret so state comparisons see what was written; GitHub
 * never reveals a webhook secret, so every echo masks it.
 *   config.secret on any read or write echo -> "********"
 */

import type { ListMockSpec } from "../../../test/e2e/mock/list-fragment.js";
import { completeHook } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  maskedConfig,
  maskHookSecret,
  noContent,
  ok,
  type SectionRestHandlers,
  slicePage,
  storedHookConfig,
} from "../../../test/e2e/mock/support.js";

/**
 * The seed completion buildState applies (test/e2e/mock/state.ts LIST_MOCKS). A hook's server
 * fields are minted by completeHook, which buildState runs over every seed and the create handler
 * below runs over every body, so this spec adds only the id it is handed.
 */
export const WEBHOOKS_MOCK: ListMockSpec = {
  collection: (state) => state.hooks,
  defaults: {},
  owned: (id) => ({ id }),
  unique: "identity",
};

export const webhooksMockHandlers: SectionRestHandlers<"webhooks"> = {
  "webhooks.list": ({ state, query }) => ok(slicePage(state.hooks.map(maskHookSecret), query)),
  "webhooks.create": ({ state, body }) => {
    const payload = asObject(body);
    const hook = completeHook(
      { ...payload, config: storedHookConfig(asObject(payload.config)) },
      state.nextId++,
      state.slug,
    );
    state.hooks.push(hook);
    return { status: 201, body: maskHookSecret(hook) };
  },
  "webhooks.update": ({ state, param, body }) => {
    const id = param("hook_id");
    const hook = state.hooks.find((h) => String(h.id) === id);
    if (!hook) {
      return { status: 404, body: { message: "Not Found" } };
    }
    const payload = asObject(body);
    // GitHub's general PATCH REPLACES the whole config when the body carries one, secret included:
    // the exact semantics the section avoids by routing config drift through the sub-endpoint.
    // Modeled faithfully so a regression that sends config through this route shows up as lost state.
    if (payload.config !== undefined) {
      hook.config = storedHookConfig(asObject(payload.config));
    }
    if (payload.events !== undefined) {
      hook.events = payload.events;
    }
    if (payload.active !== undefined) {
      hook.active = payload.active;
    }
    return ok(maskHookSecret(hook));
  },
  "webhooks.updateConfig": ({ state, param, body }) => {
    const id = param("hook_id");
    const hook = state.hooks.find((h) => String(h.id) === id);
    if (!hook) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // The config sub-endpoint UPDATES the named fields and leaves the rest alone: it never removes
    // an existing secret the payload omits.
    hook.config = storedHookConfig({ ...asObject(hook.config), ...asObject(body) });
    return ok(maskedConfig(asObject(hook.config)));
  },
  "webhooks.remove": ({ state, param }) => {
    const id = param("hook_id");
    const index = state.hooks.findIndex((h) => String(h.id) === id);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.hooks.splice(index, 1);
    return noContent();
  },
};
