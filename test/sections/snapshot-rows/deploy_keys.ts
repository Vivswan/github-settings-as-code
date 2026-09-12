import { deployKeysSection } from "../../../src/sections/deploy_keys/index.js";
import type { Row } from "../snapshot-roundtrip.js";

export const row: Row = {
  section: deployKeysSection,
  live: {
    deploy_keys: [
      { title: "ci-deploy", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample deploy@ci" },
      {
        title: "read-write",
        key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther",
        read_only: false,
      },
    ],
  },
  expected: {
    value: {
      _undeclared: "keep",
      entries: [
        {
          title: "ci-deploy",
          key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample",
          read_only: false,
        },
        {
          title: "read-write",
          key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOther",
          read_only: false,
        },
      ],
    },
    notes: [],
  },
};
