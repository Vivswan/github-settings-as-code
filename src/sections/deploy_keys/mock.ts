/**
 * The deploy_keys e2e mock fragment, derived from the section's declaration (test/e2e/mock/list-fragment.ts):
 * only the server-owned facts live here. Imports only the leaf seams (never routes.ts or
 * sections.ts); the bundle entry is src/main.ts, so this fragment never reaches lib/index.js.
 */

import { type ListMockSpec, mockFragmentFor } from "../../../test/e2e/mock/list-fragment.js";
import { type SectionRestHandlers, storedKeyMaterial } from "../../../test/e2e/mock/support.js";
import { deployKeysSection } from "./index.js";

/**
 * What the server owns on a deploy key: the read/write default, the material stored comment-free
 * the way GitHub normalizes it, the fixed audit fields (so a repeat apply leaves state byte-stable),
 * and uniqueness by that stored material - GitHub allows repeated titles ("key is already in use").
 */
export const DEPLOY_KEYS_MOCK: ListMockSpec = {
  collection: (state) => state.deploy_keys,
  defaults: { read_only: false },
  owned: (id, slug, key) => ({
    id,
    key: storedKeyMaterial(String(key.key ?? "")),
    url: `https://api.github.com/repos/${slug}/keys/${id}`,
    verified: true,
    created_at: "2026-07-01T00:00:00Z",
  }),
  unique: (key) => storedKeyMaterial(String(key.key ?? "")),
};

export const deployKeysMockHandlers: SectionRestHandlers<"deploy_keys"> = mockFragmentFor(
  deployKeysSection,
  DEPLOY_KEYS_MOCK,
);
