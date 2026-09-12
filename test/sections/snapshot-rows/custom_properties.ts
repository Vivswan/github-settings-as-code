import { customPropertiesSection } from "../../../src/sections/custom_properties/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: customPropertiesSection,
  live: {
    custom_property_values: [
      { property_name: "tier", value: "gold" },
      // A live duplicate option reads back once: the planner compares lists as sets.
      { property_name: "compliance", value: ["soc2", "hipaa", "soc2"] },
      { property_name: "pilot", value: null },
      // An empty list is unset, like null: the planner refuses a declared []. An empty STRING
      // is a value GitHub stores, so it stays.
      { property_name: "team", value: [] },
      { property_name: "owner", value: "" },
    ],
  },
  expected: {
    value: {
      _undeclared: "keep",
      entries: [
        { property_name: "tier", value: "gold" },
        { property_name: "compliance", value: ["soc2", "hipaa"] },
        { property_name: "owner", value: "" },
      ],
    },
    notes: [],
  },
};
