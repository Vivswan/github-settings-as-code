/**
 * The labels e2e mock fragment, derived from the section's declaration (test/e2e/mock/list-fragment.ts):
 * only the server-owned facts live here. Imports only the leaf seams (never routes.ts or
 * sections.ts); the bundle entry is src/main.ts, so this fragment never reaches lib/index.js.
 */

import { type ListMockSpec, mockFragmentFor } from "../../../test/e2e/mock/list-fragment.js";
import type { SectionRestHandlers } from "../../../test/e2e/mock/support.js";
import { labelsSection } from "./index.js";

/** What the server fills in on a label: GitHub's default color, the null description, and the minted identity. */
export const LABELS_MOCK: ListMockSpec = {
  collection: (state) => state.labels,
  defaults: { color: "ededed", description: null },
  // One id feeds both identity fields: the node_id encodes the label's OWN
  // id, and the url names the owning state's slug, so a multi-repo target's
  // created label reads back as its own repository's resource.
  owned: (id, slug, label) => ({
    id,
    node_id: `MDU6TGFiZWw${id}`,
    url: `https://api.github.com/repos/${slug}/labels/${String(label.name)}`,
    default: false,
  }),
};

export const labelsMockHandlers: SectionRestHandlers<"labels"> = mockFragmentFor(
  labelsSection,
  LABELS_MOCK,
);
