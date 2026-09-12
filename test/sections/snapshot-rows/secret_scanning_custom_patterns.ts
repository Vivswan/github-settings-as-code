import { secretScanningPatternsSection } from "../../../src/sections/secret_scanning_custom_patterns/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: secretScanningPatternsSection,
  live: {
    secret_scanning_patterns: [
      {
        id: 1,
        name: "acme-token",
        slug: "acme-token",
        pattern: "acme_[a-z0-9]{32}",
        start_delimiter: "\\A|[^0-9A-Za-z]",
        must_match: ["[a-z]"],
        must_not_match: null,
        state: "published",
        push_protection_enabled: false,
        custom_pattern_version: "v1",
      },
    ],
  },
  expected: {
    value: {
      _undeclared: "keep",
      entries: [
        {
          name: "acme-token",
          pattern: "acme_[a-z0-9]{32}",
          start_delimiter: "\\A|[^0-9A-Za-z]",
          must_match: ["[a-z]"],
        },
      ],
    },
    notes: [],
  },
};
