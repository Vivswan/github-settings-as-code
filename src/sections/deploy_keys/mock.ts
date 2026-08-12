/**
 * The deploy_keys section's e2e mock fragment, registered in
 * test/e2e/mock/sections.ts. Imports the test-tree seams (mock/support.ts and
 * the harness constants) on purpose - the bundle entry is src/main.ts, so
 * this fragment never reaches lib/index.js - and never routes.ts or
 * sections.ts.
 */

import {
  asObject,
  type Handler,
  type Json,
  noContent,
  ok,
  slicePage,
  storedKeyMaterial,
} from "../../../test/e2e/mock/support.js";

export const deployKeysMockHandlers: Record<string, Handler> = {
  "deploy_keys.list": ({ state, query }) => ok(slicePage(state.deploy_keys, query)),
  "deploy_keys.create": ({ state, body }) => {
    const payload = asObject(body);
    const stored = storedKeyMaterial(String(payload.key ?? ""));
    // One repository per public key, account-wide on GitHub; this state is
    // one repo, so a duplicate stored blob answers GitHub's 422. The section
    // itself rejects duplicate declared material and cross-title conflicts
    // upfront, so no section path reaches this branch anymore; it stays as
    // defensive modeling of GitHub's real answer for any other mock client.
    if (state.deploy_keys.some((k) => storedKeyMaterial(String(k.key)) === stored)) {
      return {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [
            {
              resource: "PublicKey",
              code: "custom",
              field: "key",
              message: "key is already in use",
            },
          ],
          documentation_url:
            "https://docs.github.com/rest/deploy-keys/deploy-keys#create-a-deploy-key",
        },
      };
    }
    const id = state.nextId++;
    const key: Json = {
      id,
      key: stored,
      url: `https://api.github.com/repos/${state.slug}/keys/${id}`,
      title: String(payload.title ?? ""),
      verified: true,
      // Fixed so a repeat apply leaves the state byte-stable (idempotence).
      created_at: "2026-07-01T00:00:00Z",
      read_only: payload.read_only === true,
    };
    state.deploy_keys.push(key);
    return { status: 201, body: key };
  },
  "deploy_keys.remove": ({ state, param }) => {
    const id = param("key_id");
    const index = state.deploy_keys.findIndex((k) => String(k.id) === id);
    if (index < 0) {
      return { status: 404, body: { message: "Not Found" } };
    }
    state.deploy_keys.splice(index, 1);
    return noContent();
  },
};
