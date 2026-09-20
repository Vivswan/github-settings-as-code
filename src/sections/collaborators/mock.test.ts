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
import { roleForPermission } from "../shared/roles.js";
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

describe("collaborators.update refuses a permission GitHub would not grant", () => {
  test.each(["write", "read", "Admin", "", "push "])(
    "%j on an existing collaborator is a 422, and the role is unchanged",
    (permission) => {
      const state = stateWith({ collaborators: [{ login: "alice", role_name: "read" }] });
      const response = grant(state, "alice", { permission });
      expect(response.status).toBe(422);
      expect(state.collaborators[0]?.role_name).toBe("read");
    },
  );

  test("the same spelling on a new collaborator is a 422 and creates no invitation", () => {
    const state = stateWith({});
    expect(grant(state, "bob", { permission: "write" }).status).toBe(422);
    expect(state.invitations).toEqual([]);
  });

  test("a standard permission and a defined custom role are granted", () => {
    const state = stateWith({ collaborators: [{ login: "alice", role_name: "read" }] });
    expect(grant(state, "alice", { permission: "maintain" }).status).toBe(204);
    expect(state.collaborators[0]?.role_name).toBe("maintain");
    expect(grant(state, "alice", { permission: "security-team" }).status).toBe(204);
    expect(state.collaborators[0]?.role_name).toBe("security-team");
    expect(grant(state, "carol", {}).status).toBe(201);
  });
});

describe("a personal account's repository takes pull, push, admin and nothing else", () => {
  // The spec text says the PUT's permission is "only valid on organization-owned repositories"; live GitHub honors
  // pull, push, and admin on a personal repository and 422s triage, maintain, and any custom role name.
  test.each(["triage", "maintain", "security-team"])(
    "%j on a personal repository is a 422, and the role is unchanged",
    (permission) => {
      const state = stateWith({ collaborators: [{ login: "alice", role_name: "read" }] }, "user");
      const response = grant(state, "alice", { permission });
      expect(response.status).toBe(422);
      expect(response.requestOffSpec).toBe(true);
      expect(state.collaborators[0]?.role_name).toBe("read");
    },
  );

  test.each(["pull", "push", "admin"])("%j on a personal repository is granted", (permission) => {
    const state = stateWith({ collaborators: [{ login: "alice", role_name: "read" }] }, "user");
    expect(grant(state, "alice", { permission }).status).toBe(204);
    expect(state.collaborators[0]?.role_name).toBe(roleForPermission(permission));
  });

  test("the same triage on an organization repository is granted", () => {
    const state = stateWith({ collaborators: [{ login: "alice", role_name: "read" }] }, "org");
    expect(grant(state, "alice", { permission: "triage" }).status).toBe(204);
    expect(state.collaborators[0]?.role_name).toBe("triage");
  });

  test("the invitation PATCH narrows the same way: maintain is a 422, admin is set", () => {
    const state = stateWith(
      { invitations: [{ id: 5, invitee: { login: "dan" }, permissions: "read" }] },
      "user",
    );
    expect(patchInvitation(state, "5", { permissions: "maintain" }).status).toBe(422);
    expect(state.invitations[0]?.permissions).toBe("read");
    expect(patchInvitation(state, "5", { permissions: "admin" }).status).toBe(200);
    expect(state.invitations[0]?.permissions).toBe("admin");
  });
});

describe("collaborators.updateInvitation refuses a permissions value outside the spec's enum", () => {
  test("the grant vocabulary (push) is not the invitation's (write)", () => {
    const state = stateWith({
      invitations: [{ id: 5, invitee: { login: "dan" }, permissions: "read" }],
    });
    const response = patchInvitation(state, "5", { permissions: "push" });
    expect(response.status).toBe(422);
    expect(response.requestOffSpec).toBe(true);
    expect(state.invitations[0]?.permissions).toBe("read");
  });
});
