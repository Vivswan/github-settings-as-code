import { workflowsSection } from "../../../src/sections/workflows/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: workflowsSection,
  live: {
    workflows: [
      { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_manually" },
      { id: 3, name: "Gone", path: ".github/workflows/gone.yml", state: "deleted" },
    ],
  },
  expected: {
    value: [
      { path: ".github/workflows/ci.yml", state: "active" },
      { path: ".github/workflows/old.yml", state: "disabled" },
    ],
    notes: [],
  },
};
