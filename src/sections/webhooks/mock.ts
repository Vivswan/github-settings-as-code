/**
 * The webhooks section's e2e mock fragment, registered in
 * test/e2e/mock/sections.ts. Imports the test-tree seams (mock/support.ts and
 * mock/state.ts) on purpose - the bundle entry is src/main.ts, so this
 * fragment never reaches lib/index.js - and never routes.ts or sections.ts.
 *
 * The stored hook keeps its REAL config.secret (so state comparisons see
 * what was written), but every response echoes it as "********" - GitHub
 * never reveals a webhook secret on any read or write echo.
 */

import { completeHook } from "../../../test/e2e/mock/state.js";
import {
  asObject,
  type Handler,
  HOOK_CANONICAL_KEYS,
  maskedConfig,
  maskHookSecret,
  noContent,
  ok,
  slicePage,
  storedHookConfig,
} from "../../../test/e2e/mock/support.js";

export const webhooksMockHandlers: Record<string, Handler> = {
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
    // GitHub's general PATCH REPLACES the whole config when the body carries
    // one (removing undeclared keys, the secret included) - the exact
    // semantics the section avoids by routing config drift through the
    // config sub-endpoint. Modeled faithfully so a regression that sends
    // config through this route shows up as lost state.
    if (payload.config !== undefined) {
      hook.config = storedHookConfig(asObject(payload.config));
    }
    if (payload.events !== undefined) {
      hook.events = payload.events;
    }
    if (payload.active !== undefined) {
      hook.active = payload.active;
    }
    for (const [key, value] of Object.entries(payload)) {
      if (!HOOK_CANONICAL_KEYS.has(key)) {
        hook[key] = value; // passthrough fields read back verbatim
      }
    }
    return ok(maskHookSecret(hook));
  },
  "webhooks.updateConfig": ({ state, param, body }) => {
    const id = param("hook_id");
    const hook = state.hooks.find((h) => String(h.id) === id);
    if (!hook) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // The config sub-endpoint UPDATES the named fields and leaves the rest
    // alone - it never removes an existing secret the payload omits.
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
