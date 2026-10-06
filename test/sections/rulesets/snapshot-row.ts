import { rulesetsSection } from "../../../src/sections/rulesets/index.js";
import type { Row } from "../snapshot-roundtrip.js";

// The all-grades token sees bypass_actors; the server fields fall away; the organization's ruleset
// is noted, not declared. A field GitHub adds to a rule's parameters or a bypass actor (the two
// `future_*` keys) survives the projection, or the next full-payload update would clear it.
export const row: Row = {
  section: rulesetsSection,
  live: {
    rulesets: [
      {
        id: 42,
        name: "protect-main",
        node_id: "RRS_lACqUmVwb3NpdG9yeQ",
        source_type: "Repository",
        source: "o/r",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          { type: "deletion" },
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 2,
              dismiss_stale_reviews_on_push: true,
              require_code_owner_review: false,
              require_last_push_approval: false,
              required_review_thread_resolution: false,
              future_knob: "kept",
            },
          },
        ],
        bypass_actors: [
          { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always", future_field: true },
        ],
        current_user_can_bypass: "always",
        _links: { self: { href: "https://api.github.com/repos/o/r/rulesets/42" } },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      },
      {
        id: 43,
        name: "org-baseline",
        source_type: "Organization",
        source: "o",
        target: "branch",
        enforcement: "active",
        rules: [{ type: "non_fast_forward" }],
      },
    ],
  },
  expected: {
    value: {
      _undeclared: "keep",
      entries: [
        {
          name: "protect-main",
          target: "branch",
          enforcement: "active",
          conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
          rules: [
            { type: "deletion" },
            {
              type: "pull_request",
              parameters: {
                required_approving_review_count: 2,
                dismiss_stale_reviews_on_push: true,
                require_code_owner_review: false,
                require_last_push_approval: false,
                required_review_thread_resolution: false,
                future_knob: "kept",
              },
            },
          ],
          bypass_actors: [
            {
              actor_id: 5,
              actor_type: "RepositoryRole",
              bypass_mode: "always",
              future_field: true,
            },
          ],
        },
      ],
    },
    notes: [
      'rulesets[org-baseline]: left out of the snapshot - inherited from the organization (source_type "Organization"); manage it where it is defined',
    ],
  },
};
