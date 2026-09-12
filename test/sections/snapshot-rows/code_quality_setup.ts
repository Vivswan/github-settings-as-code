import { codeQualitySetupSection } from "../../../src/sections/code_quality_setup/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: codeQualitySetupSection,
  // The not-configured default: runner_type is null where the slice takes no null, so it is
  // omitted; runner_label is nullable and stays.
  live: {},
  expected: {
    value: { state: "not-configured", languages: [], runner_label: null },
    notes: [],
  },
};
