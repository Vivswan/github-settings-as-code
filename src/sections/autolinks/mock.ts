/**
 * The autolinks e2e mock fragment, derived from the section's declaration by
 * test/e2e/mock/list-fragment.ts; only the server-owned facts live here. It imports the test-tree
 * seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { type ListMockSpec, mockFragmentFor } from "../../../test/e2e/mock/list-fragment.js";
import type { SectionRestHandlers } from "../../../test/e2e/mock/support.js";
import { autolinksSection } from "./index.js";

export const AUTOLINKS_MOCK: ListMockSpec = {
  collection: (state) => state.autolinks,
  defaults: { is_alphanumeric: true },
  owned: (id) => ({ id }),
  unique: "identity",
};

export const autolinksMockHandlers: SectionRestHandlers<"autolinks"> = mockFragmentFor(
  autolinksSection,
  AUTOLINKS_MOCK,
);
