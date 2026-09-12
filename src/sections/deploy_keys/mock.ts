/**
 * The deploy_keys e2e mock fragment, derived from the section's declaration by
 * test/e2e/mock/list-fragment.ts; only the server-owned facts live here. It imports the test-tree
 * seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { type ListMockSpec, mockFragmentFor } from "../../../test/e2e/mock/list-fragment.js";
import { type SectionRestHandlers, storedKeyMaterial } from "../../../test/e2e/mock/support.js";
import { deployKeysSection } from "./index.js";

/**
 * The material is stored comment-free the way GitHub normalizes it, the audit fields are fixed so a
 * repeat apply stays byte-stable, and uniqueness is by stored material: GitHub allows repeated titles.
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
