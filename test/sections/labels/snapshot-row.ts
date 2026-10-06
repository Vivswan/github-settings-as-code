import { labelsSection } from "../../../src/sections/labels/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: labelsSection,
  live: {
    labels: [
      { name: "bug", color: "d73a4a", description: "Something is broken" },
      { name: "docs", color: "0075CA" },
    ],
  },
  expected: {
    value: {
      _undeclared: "delete",
      entries: [
        { name: "bug", color: "d73a4a", description: "Something is broken" },
        // The mock completes the seed with GitHub's null description, which the file spells "".
        { name: "docs", color: "0075ca", description: "" },
      ],
    },
    notes: [],
  },
};
