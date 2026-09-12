import { webhooksSection } from "../../../src/sections/webhooks/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: webhooksSection,
  live: {
    hooks: [
      {
        id: 601,
        events: ["push", "pull_request"],
        config: {
          url: "https://ci.example.com/hook",
          content_type: "json",
          insecure_ssl: "0",
          secret: "the-live-secret",
        },
      },
      { id: 602, active: false, config: { url: "https://deploy.example.com/hook" } },
    ],
  },
  expected: {
    value: {
      _undeclared: "keep",
      entries: [
        {
          name: "web",
          config: {
            url: "https://ci.example.com/hook",
            content_type: "json",
            insecure_ssl: "0",
            secret: "$WEBHOOK_SECRET_601",
          },
          events: ["push", "pull_request"],
          active: true,
        },
        {
          name: "web",
          config: { url: "https://deploy.example.com/hook" },
          events: ["push"],
          active: false,
        },
      ],
    },
    notes: [
      'webhooks["https://ci.example.com/hook"].config.secret: the webhook secret is not readable; export a value as WEBHOOK_SECRET_601 into the environment before apply',
    ],
  },
};
