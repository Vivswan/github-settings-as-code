/**
 * No scenario can reach these replies (parse refuses the wrong spellings first), so the grant PUT's
 * vocabulary is pinned here against the handler: GitHub takes the five standard permissions or a
 * custom role the organization defines, and 422s anything else instead of storing it as a role.
 */

import { describe, expect, test } from "bun:test";
import { handlerTestContext } from "../../../test/e2e/mock/handler-test-ctx.js";
import { buildStateForSlug, type MockState } from "../../../test/e2e/mock/state.js";
import { collaboratorsMockHandlers } from "./mock.js";

const PARAMS = { owner: "acme", repo: "widgets" };

function grant(state: MockState, username: string, body: Record<string, unknown>) {
  return collaboratorsMockHandlers["collaborators.update"](
    handlerTestContext("collaborators.update", state, { params: { ...PARAMS, username }, body }),
  );
}

function stateWith(liveState: Record<string, unknown>): MockState {
  return buildStateForSlug("acme/widgets", { settingsYaml: null, liveState }, "org");
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

describe("collaborators.updateInvitation refuses a permissions value outside the spec's enum", () => {
  test("the grant vocabulary (push) is not the invitation's (write)", () => {
    const state = stateWith({
      invitations: [{ id: 5, invitee: { login: "dan" }, permissions: "read" }],
    });
    const response = collaboratorsMockHandlers["collaborators.updateInvitation"](
      handlerTestContext("collaborators.updateInvitation", state, {
        params: { ...PARAMS, invitation_id: "5" },
        body: { permissions: "push" },
      }),
    );
    expect(response.status).toBe(422);
    expect(response.requestOffSpec).toBe(true);
    expect(state.invitations[0]?.permissions).toBe("read");
  });
});
