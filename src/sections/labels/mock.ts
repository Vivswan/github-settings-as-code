/**
 * The labels e2e mock fragment, derived from the section's declaration by
 * test/e2e/mock/list-fragment.ts; only the server-owned facts live here. It imports the test-tree
 * seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import { type ListMockSpec, mockFragmentFor } from "../../../test/e2e/mock/list-fragment.js";
import type { SectionRestHandlers } from "../../../test/e2e/mock/support.js";
import { labelsSection } from "./index.js";

export const LABELS_MOCK: ListMockSpec = {
  collection: (state) => state.labels,
  defaults: { color: "ededed", description: null },
  owned: (id, slug, label) => ({
    id,
    node_id: `MDU6TGFiZWw${id}`,
    url: `https://api.github.com/repos/${slug}/labels/${String(label.name)}`,
    default: false,
  }),
  unique: "identity",
};

export const labelsMockHandlers: SectionRestHandlers<"labels"> = mockFragmentFor(
  labelsSection,
  LABELS_MOCK,
);
