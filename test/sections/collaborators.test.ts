import { describe, expect, test } from "bun:test";
import { collaboratorsSection } from "../../src/sections/collaborators.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("collaborators", () => {
  test("collaborator push matches live role_name write", async () => {
    const api = new MockApi({
      "GET /repos/o/r/collaborators?affiliation=direct&per_page=100&page=1": {
        data: [{ login: "alice", role_name: "write" }],
      },
    });
    const result = await collaboratorsSection.run(ctx(api, true), [
      { username: "alice", permission: "push" },
    ]);
    expect(result.drift).toEqual([]);
  });

  test("wrapped undeclared:keep notes the undeclared collaborator, never a DELETE", async () => {
    const api = new MockApi({
      "GET /repos/o/r/collaborators?affiliation=direct&per_page=100&page=1": {
        data: [
          { login: "alice", role_name: "write" },
          { login: "bob", role_name: "read" },
        ],
      },
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
      "GET /repos/o/r/collaborators?affiliation=direct&per_page=100&page=1": {
        data: [
          { login: "O", role_name: "admin" }, // the owner, case-insensitively
          { login: "bob", role_name: "read" },
        ],
      },
    }).allowMutations("DELETE /repos/o/r/collaborators/*");
    const result = await collaboratorsSection.run(ctx(api), { entries: [] });
    expect(result.changes).toEqual(['REMOVED undeclared collaborator "bob"']);
    expect(api.mutations().map((m) => m.path)).toEqual(["/repos/o/r/collaborators/bob"]);
  });
});
