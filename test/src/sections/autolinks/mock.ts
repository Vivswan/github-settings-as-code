/**
 * The autolinks e2e mock fragment, derived from the section's declaration by
 * test/e2e/mock/list-fragment.ts; only the server-owned facts live here.
 */

import { autolinksSection } from "../../../../src/sections/autolinks/index.js";
import { type ListMockSpec, mockFragmentFor } from "../../../e2e/mock/list-fragment.js";
import type { SectionRestHandlers } from "../../../e2e/mock/support.js";

export const AUTOLINKS_MOCK: ListMockSpec = {
  collection: (state) => state.autolinks,
  defaults: { is_alphanumeric: true },
  owned: (id) => ({ id }),
  unique: "identity",
  // GitHub refuses a prefix that begins, or is begun by, a stored one; the planner deletes an
  // undeclared one before the create that would collide with it.
  rejects: (item, siblings) => {
    const prefix = String(item.key_prefix);
    const overlapping = siblings.find((live) => {
      const stored = String(live.key_prefix);
      return stored.startsWith(prefix) || prefix.startsWith(stored);
    });
    return overlapping === undefined
      ? undefined
      : `Validation Failed: key_prefix "${prefix}" overlaps the existing autolink "${String(overlapping.key_prefix)}"`;
  },
};

export const autolinksMockHandlers: SectionRestHandlers<"autolinks"> = mockFragmentFor(
  autolinksSection,
  AUTOLINKS_MOCK,
);
