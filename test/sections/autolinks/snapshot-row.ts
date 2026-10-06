import { autolinksSection } from "../../../src/sections/autolinks/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: autolinksSection,
  live: { autolinks: [{ key_prefix: "JIRA-", url_template: "https://jira.example.com/<num>" }] },
  expected: {
    value: {
      _undeclared: "delete",
      entries: [
        {
          key_prefix: "JIRA-",
          url_template: "https://jira.example.com/<num>",
          is_alphanumeric: true,
        },
      ],
    },
    notes: [],
  },
};
