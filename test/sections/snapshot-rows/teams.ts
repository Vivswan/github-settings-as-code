import { teamsSection } from "../../../src/sections/teams/index.js";
import type { Row } from "../snapshot-roundtrip.js";

// A null access entry is a team without access, which the listing omits; a custom role named
// "push" has no declaration that plans as itself. The wrapper spells the section's keep default out.
export const row: Row = {
  section: teamsSection,
  live: {
    teams: {
      platform: { role_name: "write" },
      auditors: { role_name: "security-auditor" },
      readers: { role_name: "read" },
      pushy: { role_name: "push" },
      none: null,
    },
  },
  expected: {
    value: {
      _undeclared: "keep",
      entries: [
        { name: "platform", permission: "push" },
        { name: "auditors", permission: "security-auditor" },
        { name: "readers", permission: "pull" },
      ],
    },
    notes: [
      'teams[pushy]: left out of the snapshot - the live role "push" has no declaration that plans as itself ("push" in a settings file means the "write" role)',
    ],
  },
};
