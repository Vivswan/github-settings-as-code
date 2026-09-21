import { deployKeysSection } from "../../../src/sections/deploy_keys/index.js";
import type { Row } from "../snapshot-roundtrip.js";

// The ssh-ed448 key is one GitHub holds under an algorithm the settings file cannot declare: left out and noted.
export const row: Row = {
  section: deployKeysSection,
  live: {
    deploy_keys: [
      { title: "ci-deploy", key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample deploy@ci" },
      {
        title: "read-write",
        key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAnother",
        read_only: false,
      },
      { title: "future", key: "ssh-ed448 AAAACXNzaC1lZDQ0OAAAADlGdXR1cmVBbGdvcml0aG0=" },
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
          key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAnother",
          read_only: false,
        },
      ],
    },
    notes: [
      'deploy_keys[future]: left out of the snapshot - its algorithm "ssh-ed448" is not one the settings file can declare ' +
        "(ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256, ecdsa-sha2-nistp384, ecdsa-sha2-nistp521, " +
        "sk-ssh-ed25519@openssh.com, sk-ecdsa-sha2-nistp256@openssh.com), so the section leaves the key as GitHub holds it",
    ],
  },
};
