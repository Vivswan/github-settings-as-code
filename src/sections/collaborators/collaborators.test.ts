import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { collaboratorsSection } from "./index.js";

const LIST_KEY = "GET /repos/o/r/collaborators?affiliation=direct&per_page=100&page=1";
const INVITATIONS_KEY = "GET /repos/o/r/invitations?per_page=100&page=1";

describe("collaborators", () => {
  test("collaborator push matches live role_name write", async () => {
    const api = new MockApi({
      [LIST_KEY]: { data: [{ login: "alice", role_name: "write" }] },
      [INVITATIONS_KEY]: { data: [] },
    });
    const result = await collaboratorsSection.run(ctx(api, true), [
      { username: "alice", permission: "push" },
    ]);
    expect(result.drift).toEqual([]);
  });

  test("wrapped undeclared:keep notes the undeclared collaborator, never a DELETE", async () => {
    const api = new MockApi({
      [LIST_KEY]: {
        data: [
          { login: "alice", role_name: "write" },
          { login: "bob", role_name: "read" },
        ],
      },
      [INVITATIONS_KEY]: { data: [] },
    });
    const result = await collaboratorsSection.run(ctx(api), {
      undeclared: "keep",
      entries: [{ username: "alice", permission: "push" }],
    });
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([
      'collaborator "bob" has access but is not declared in the settings file; kept under "undeclared: keep" - add them to the settings file to manage their access, or set "undeclared: delete" to have apply REMOVE them',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("the delete default still removes undeclared collaborators but never the owner", async () => {
    const api = new MockApi({
      [LIST_KEY]: {
        data: [
          { login: "O", role_name: "admin" }, // the owner, case-insensitively
          { login: "bob", role_name: "read" },
        ],
      },
      [INVITATIONS_KEY]: { data: [] },
    }).allowMutations("DELETE /repos/o/r/collaborators/*");
    const result = await collaboratorsSection.run(ctx(api), { entries: [] });
    expect(result.changes).toEqual(['REMOVED undeclared collaborator "bob"']);
    expect(api.mutations().map((m) => m.path)).toEqual(["/repos/o/r/collaborators/bob"]);
  });

  test("a pending invitation at the declared permission converges without a write", async () => {
    const api = new MockApi({
      [LIST_KEY]: { data: [] },
      [INVITATIONS_KEY]: {
        data: [{ id: 7, invitee: { login: "Alice" }, permissions: "write", expired: false }],
      },
    });
    const check = await collaboratorsSection.run(ctx(api, true), [
      { username: "alice", permission: "push" },
    ]);
    expect(check.drift).toEqual([]);
    const apply = await collaboratorsSection.run(ctx(api), [
      { username: "alice", permission: "push" },
    ]);
    expect(apply.changes).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("a pending invitation at a stale permission is PATCHed in the read vocabulary", async () => {
    const api = new MockApi({
      [LIST_KEY]: { data: [] },
      [INVITATIONS_KEY]: {
        data: [{ id: 7, invitee: { login: "alice" }, permissions: "read", expired: false }],
      },
    }).allowMutations("PATCH /repos/o/r/invitations/*");
    const result = await collaboratorsSection.run(ctx(api), [
      { username: "alice", permission: "push" },
    ]);
    expect(result.changes).toEqual(['updated pending invitation for "alice" (push)']);
    expect(api.mutations()).toEqual([
      { method: "PATCH", path: "/repos/o/r/invitations/7", payload: { permissions: "write" } },
    ]);
  });

  test("check mode reports pending-invitation drift without writing", async () => {
    const api = new MockApi({
      [LIST_KEY]: { data: [] },
      [INVITATIONS_KEY]: {
        data: [
          { id: 7, invitee: { login: "alice" }, permissions: "read", expired: false },
          { id: 8, invitee: { login: "mallory" }, permissions: "write", expired: false },
        ],
      },
    });
    const result = await collaboratorsSection.run(ctx(api, true), [
      { username: "alice", permission: "push" },
    ]);
    expect(result.drift).toEqual([
      'collaborators[alice]: pending invitation permission "read" != declared "write"; apply will update the invitation',
      "collaborators[mallory]: undeclared - a pending invitation not in the settings file, so apply will CANCEL it; add them to the settings file to keep the invitation",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("an expired invitation is cancelled and the user re-invited", async () => {
    const api = new MockApi({
      [LIST_KEY]: { data: [] },
      [INVITATIONS_KEY]: {
        data: [{ id: 7, invitee: { login: "alice" }, permissions: "write", expired: true }],
      },
    }).allowMutations("DELETE /repos/o/r/invitations/*", "PUT /repos/o/r/collaborators/*");
    const result = await collaboratorsSection.run(ctx(api), [
      { username: "alice", permission: "push" },
    ]);
    expect(result.changes).toEqual([
      're-invited collaborator "alice" (push) - the pending invitation had expired',
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/invitations/7",
      "PUT /repos/o/r/collaborators/alice",
    ]);
  });

  test("an undeclared pending invitation is cancelled under the delete default, kept as a note under keep", async () => {
    const invitations = {
      data: [{ id: 9, invitee: { login: "mallory" }, permissions: "write", expired: false }],
    };
    const deleteApi = new MockApi({
      [LIST_KEY]: { data: [] },
      [INVITATIONS_KEY]: invitations,
    }).allowMutations("DELETE /repos/o/r/invitations/*");
    const cancelled = await collaboratorsSection.run(ctx(deleteApi), { entries: [] });
    expect(cancelled.changes).toEqual(['CANCELLED undeclared invitation for "mallory"']);
    expect(deleteApi.mutations().map((m) => m.path)).toEqual(["/repos/o/r/invitations/9"]);

    const keepApi = new MockApi({
      [LIST_KEY]: { data: [] },
      [INVITATIONS_KEY]: invitations,
    });
    const kept = await collaboratorsSection.run(ctx(keepApi), {
      undeclared: "keep",
      entries: [],
    });
    expect(kept.changes).toEqual([]);
    expect(kept.notes).toEqual([
      'invitation for "mallory" is pending but not declared in the settings file; kept under "undeclared: keep" - add them to the settings file to manage their access, or set "undeclared: delete" to have apply CANCEL the invitation',
    ]);
    expect(keepApi.mutations()).toEqual([]);
  });

  test("an email invitation (null invitee) is noted and left untouched by both sweeps", async () => {
    const api = new MockApi({
      [LIST_KEY]: { data: [] },
      [INVITATIONS_KEY]: {
        data: [{ id: 10, invitee: null, permissions: "write", expired: false }],
      },
    });
    const result = await collaboratorsSection.run(ctx(api), { entries: [] });
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([
      "invitation 10 was sent by email, so no username can declare it; left untouched - cancel it from the repository's Access settings if it is unwanted",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("a custom-role mismatch is never PATCHed nor re-sent; the invitation is noted", async () => {
    const routes = {
      [LIST_KEY]: { data: [] },
      [INVITATIONS_KEY]: {
        data: [{ id: 11, invitee: { login: "alice" }, permissions: "write", expired: false }],
      },
    };
    const applyApi = new MockApi(routes);
    const applied = await collaboratorsSection.run(ctx(applyApi), [
      { username: "alice", permission: "security-team" },
    ]);
    expect(applied.changes).toEqual([]);
    expect(applied.notes).toEqual([
      'invitation for "alice" is pending; invitations report only the standard roles, so it cannot be compared to the declared custom role "security-team" - left untouched, the declared role is applied once the invitation is accepted',
    ]);
    expect(applyApi.mutations()).toEqual([]);

    const checkApi = new MockApi(routes);
    const checked = await collaboratorsSection.run(ctx(checkApi, true), [
      { username: "alice", permission: "security-team" },
    ]);
    expect(checked.drift).toEqual([]);
    expect(checkApi.mutations()).toEqual([]);
  });

  test("an expired invitation under a custom role is still cancelled and re-sent", async () => {
    const api = new MockApi({
      [LIST_KEY]: { data: [] },
      [INVITATIONS_KEY]: {
        data: [{ id: 12, invitee: { login: "alice" }, permissions: "write", expired: true }],
      },
    }).allowMutations("DELETE /repos/o/r/invitations/*", "PUT /repos/o/r/collaborators/*");
    const result = await collaboratorsSection.run(ctx(api), [
      { username: "alice", permission: "security-team" },
    ]);
    expect(result.changes).toEqual([
      're-invited collaborator "alice" (security-team) - the pending invitation had expired',
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/invitations/12",
      "PUT /repos/o/r/collaborators/alice",
    ]);
  });
});
