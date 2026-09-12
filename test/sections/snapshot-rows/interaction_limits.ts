import { interactionLimitsSection } from "../../../src/sections/interaction_limits/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: interactionLimitsSection,
  live: {
    interaction_limits: {
      limit: "collaborators_only",
      origin: "repository",
      expires_at: "2027-01-02T00:00:00Z",
    },
    pull_creation_cap: { enabled: true, max_open_pull_requests: 5 },
    pull_bypass_list: [{ login: "octocat" }],
  },
  expected: {
    value: {
      limit: "collaborators_only",
      pull_request_creation_cap: { enabled: true, max_open_pull_requests: 5 },
      pull_request_creation_bypass: ["octocat"],
    },
    notes: [
      "interaction_limits.expiry: GitHub reports only the computed expires_at, so the declared duration cannot be read back; apply re-arms the limit with GitHub's default (one_day) unless you declare expiry",
    ],
  },
};
