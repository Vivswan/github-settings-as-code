import { codeScanningDefaultSetupSection } from "../../../src/sections/code_scanning_default_setup/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: codeScanningDefaultSetupSection,
  live: {
    code_scanning: {
      state: "configured",
      languages: ["javascript-typescript"],
      runner_type: "standard",
      runner_label: null,
      query_suite: "default",
      threat_model: "remote",
      updated_at: "2026-07-01T10:00:00Z",
      schedule: null,
    },
  },
  expected: {
    value: {
      state: "configured",
      query_suite: "default",
      languages: ["javascript-typescript"],
      runner_type: "standard",
      runner_label: null,
      threat_model: "remote",
    },
    notes: [],
  },
};
