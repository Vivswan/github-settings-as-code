import { milestonesSection } from "../../../src/sections/milestones/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: milestonesSection,
  live: {
    milestones: [
      { id: 1, number: 1, title: "v1.0", state: "open", description: "First stable release." },
      { id: 2, number: 2, title: "v2.0", state: "closed", description: null },
    ],
  },
  expected: {
    value: {
      _undeclared: "keep",
      entries: [
        { title: "v1.0", description: "First stable release.", state: "open" },
        { title: "v2.0", state: "closed" },
      ],
    },
    notes: [],
  },
};
