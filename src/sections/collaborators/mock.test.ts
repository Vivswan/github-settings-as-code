/**
 * The grant PUT's vocabulary, pinned against the handler: parse refuses the wrong spellings before any
 * scenario can send one, and no curated scenario declares triage or maintain on a personal account. GitHub
 * takes the five standard permissions or a defined custom role on an organization's repository, pull, push,
 * admin on a personal account's, and 422s anything else instead of storing it as a role.
 */

import { describe, expect, test } from "bun:test";
import { handlerTestContext } from "../../../test/e2e/mock/handler-test-ctx.js";
import { buildStateForSlug, type MockState } from "../../../test/e2e/mock/state.js";
import type { OwnerKind } from "../../../test/e2e/schema.js";
import { collaboratorsMockHandlers } from "./mock.js";

const PARAMS = { owner: "acme", repo: "widgets" };

function grant(state: MockState, username: string, body: Record<string, unknown>) {
  return collaboratorsMockHandlers["collaborators.update"](
    handlerTestContext("collaborators.update", state, { params: { ...PARAMS, username }, body }),
  );
}

function stateWith(liveState: Record<string, unknown>, ownerKind: OwnerKind = "org"): MockState {
  return buildStateForSlug("acme/widgets", { settingsYaml: null, liveState }, ownerKind);
}

function patchInvitation(state: MockState, id: string, body: Record<string, unknown>) {
  return collaboratorsMockHandlers["collaborators.updateInvitation"](
    handlerTestContext("collaborators.updateInvitation", state, {
      params: { ...PARAMS, invitation_id: id },
      body,
    }),
  );
}

// The spec text says the PUT's permission is "only valid on organization-owned repositories"; live GitHub honors
// pull, push, and admin on a personal repository and 422s triage, maintain, and any custom role name.
describe("collaborators.update grants what GitHub would grant on this owner's repository and 422s the rest", () => {
  test.each<[OwnerKind, string, Record<string, unknown>, number, string]>([
    ["org", "alice", { permission: "write" }, 422, "read"],
    ["org", "alice", { permission: "read" }, 422, "read"],
    ["org", "alice", { permission: "Admin" }, 422, "read"],
    ["org", "alice", { permission: "" }, 422, "read"],
    ["org", "alice", { permission: "push " }, 422, "read"],
    ["org", "alice", { permission: "triage" }, 204, "triage"],
    ["org", "alice", { permission: "maintain" }, 204, "maintain"],
    ["org", "alice", { permission: "security-team" }, 204, "security-team"],
    ["org", "carol", {}, 201, "read"],
    ["user", "alice", { permission: "triage" }, 422, "read"],
    ["user", "alice", { permission: "maintain" }, 422, "read"],
    ["user", "alice", { permission: "security-team" }, 422, "read"],
    ["user", "alice", { permission: "pull" }, 204, "read"],
    ["user", "alice", { permission: "push" }, 204, "write"],
    ["user", "alice", { permission: "admin" }, 204, "admin"],
  ])(
    "on a %s repository, PUT %s %j answers %d and leaves alice's role %j",
    (ownerKind, username, body, status, roleAfter) => {
      const state = stateWith(
        { collaborators: [{ login: "alice", role_name: "read" }] },
        ownerKind,
      );
      const response = grant(state, username, body);
      expect(response.status).toBe(status);
      // Every refusal here is a value outside what GitHub takes, so the mock flags the request off-spec.
      expect(response.requestOffSpec).toBe(status === 422 ? true : undefined);
      expect(state.collaborators[0]?.role_name).toBe(roleAfter);
    },
  );

  test("the same spelling on a new collaborator is a 422 and creates no invitation", () => {
    const state = stateWith({});
    expect(grant(state, "bob", { permission: "write" }).status).toBe(422);
    expect(state.invitations).toEqual([]);
  });
});

describe("collaborators.updateInvitation takes the spec's enum, narrowed on a personal account like the grant", () => {
  test.each<[OwnerKind, string, number, string]>([
    ["user", "maintain", 422, "read"],
    ["user", "admin", 200, "admin"],
    // The grant vocabulary (push) is not the invitation's (write).
    ["org", "push", 422, "read"],
  ])(
    "on a %s repository, PATCH permissions %j answers %d and leaves the invitation at %j",
    (ownerKind, permissions, status, after) => {
      const state = stateWith(
        { invitations: [{ id: 5, invitee: { login: "dan" }, permissions: "read" }] },
        ownerKind,
      );
      const response = patchInvitation(state, "5", { permissions });
      expect(response.status).toBe(status);
      expect(response.requestOffSpec).toBe(status === 422 ? true : undefined);
      expect(state.invitations[0]?.permissions).toBe(after);
    },
  );
});
