import { collaboratorsSection } from "../../../src/sections/collaborators/index.js";
import type { Row } from "../snapshot-roundtrip.js";

// The owner is listed as a direct collaborator; the email invitation has no username to declare.
export const row: Row = {
  section: collaboratorsSection,
  live: {
    collaborators: [
      { login: "alice", role_name: "write" },
      { login: "O", role_name: "admin" },
      { login: "carol", role_name: "security-team" },
    ],
    invitations: [
      { id: 501, invitee: { login: "bob" }, permissions: "read" },
      { id: 502, invitee: null, permissions: "read" },
    ],
  },
  expected: {
    value: {
      _undeclared: "delete",
      entries: [
        { username: "alice", permission: "push" },
        { username: "carol", permission: "security-team" },
        { username: "bob", permission: "pull" },
      ],
    },
    notes: [
      "collaborators[O]: left out of the snapshot - the repository owner's access is implicit and never managed",
      "collaborators[invitation 502]: left out of the snapshot - sent by email, so no username can declare it; apply leaves it untouched",
    ],
  },
};
