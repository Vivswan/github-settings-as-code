import { describe, expect, test } from "bun:test";
import { collaboratorsSection } from "../../../../src/sections/collaborators/index.js";
import type { SectionInput } from "../../../../src/sections/contract/module.js";
import { planContext, snapshotContext } from "../../../../src/sections/contract/plan.js";
import { MockApi } from "../../../mock-api.js";
import { fragmentFake } from "../../../sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../sections/plan-idempotence.js";
import { deniedDetail, REPO, unwrap } from "../../../sections/section-run.js";
import { validatedInput } from "../../../sections/validated-input.js";
import { collaboratorsMockHandlers } from "./mock.js";

const LIST = "GET /repos/o/r/collaborators?affiliation=direct&per_page=100&page=1";
const INVITATIONS = "GET /repos/o/r/invitations?per_page=100&page=1";
const plan = async (api: MockApi, desired: SectionInput<"collaborators">) =>
  unwrap(
    await collaboratorsSection.plan(
      planContext(collaboratorsSection, api, REPO),
      validatedInput("collaborators", desired),
    ),
  );
const snapshot = async (api: MockApi) =>
  unwrap(
    await collaboratorsSection.snapshot(snapshotContext(collaboratorsSection, api, REPO, "fail")),
  );

describe("collaborators", () => {
  test("plans an update per drifted collaborator, an invitation per missing user, and a removal per undeclared one, reading only", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          { login: "Alice", role_name: "read" },
          { login: "O", role_name: "admin" },
          { login: "stale", role_name: "write" },
        ],
      },
      [INVITATIONS]: { data: [] },
    });
    const result = await plan(api, [
      { username: "alice", permission: "push" },
      { username: "bob" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { username: "alice" },
          payload: { permission: "push" },
          describe: 'updating collaborator "alice"',
          drift: [
            'collaborators[alice]: declared "write" != live "read"; apply will set the declared permission',
          ],
          change: 'updated collaborator "alice" (push)',
        },
        {
          role: "update",
          params: { username: "bob" },
          payload: { permission: "push" },
          describe: 'inviting collaborator "bob"',
          drift: [
            'collaborators[bob]: missing - not a collaborator on the repo; apply will send an invitation with "push"',
          ],
          change: 'invited collaborator "bob" (push)',
        },
        {
          role: "remove",
          params: { username: "stale" },
          drift: [
            "collaborators[stale]: undeclared - not in the settings file, so apply will REMOVE them; add them to the settings file to keep their access",
          ],
          change: 'REMOVED undeclared collaborator "stale"',
        },
      ],
      notes: [],
      drift: [],
    });
    // The owner "O" is never removed.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST, INVITATIONS]);
  });

  test("a matching role and a matching pending invitation plan nothing; keep turns the undeclared ones into notes", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          { login: "alice", role_name: "write" },
          { login: "bob", role_name: "read" },
        ],
      },
      [INVITATIONS]: {
        data: [
          { id: 7, invitee: { login: "Carol" }, permissions: "write", expired: false },
          { id: 8, invitee: { login: "mallory" }, permissions: "write", expired: false },
          { id: 9, invitee: null, permissions: "read", expired: false },
        ],
      },
    });
    const result = await plan(api, {
      _undeclared: "keep",
      entries: [
        { username: "alice", permission: "push" },
        { username: "carol", permission: "push" },
      ],
    });
    expect(result).toEqual({
      ops: [],
      notes: [
        'collaborator "bob" has access but is not declared in the settings file; kept under "_undeclared: keep" - add them to the settings file to manage their access, or set "_undeclared: delete" to have apply REMOVE them',
        'invitation for "mallory" is pending but not declared in the settings file; kept under "_undeclared: keep" - add them to the settings file to manage their access, or set "_undeclared: delete" to have apply CANCEL the invitation',
        "invitation 9 was sent by email, so no username can declare it; left untouched - cancel it from the repository's Access settings if it is unwanted",
      ],
      drift: [],
    });
  });

  test("pending invitations: a stale one is PATCHed in the read vocabulary, an expired one cancelled then re-sent, an undeclared one cancelled", async () => {
    const api = new MockApi({
      [LIST]: { data: [] },
      [INVITATIONS]: {
        data: [
          { id: 7, invitee: { login: "alice" }, permissions: "read", expired: false },
          { id: 8, invitee: { login: "bob" }, permissions: "write", expired: true },
          { id: 9, invitee: { login: "mallory" }, permissions: "write", expired: false },
        ],
      },
    });
    const result = await plan(api, [
      { username: "alice", permission: "push" },
      { username: "bob", permission: "push" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "updateInvitation",
          params: { invitation_id: "7" },
          payload: { permissions: "write" },
          describe: 'updating the pending invitation for "alice"',
          drift: [
            'collaborators[alice] (pending invitation): declared "write" != live "read"; apply will update the invitation',
          ],
          change: 'updated pending invitation for "alice" (push)',
        },
        {
          role: "cancelInvitation",
          params: { invitation_id: "8" },
          describe: 'cancelling the expired invitation for "bob"',
          drift: [
            'collaborators[bob]: pending invitation expired; apply will cancel it and send a fresh invitation with "push"',
          ],
          change: 'cancelled the expired invitation for "bob"',
        },
        {
          role: "update",
          params: { username: "bob" },
          payload: { permission: "push" },
          describe: 'inviting collaborator "bob"',
          drift: [
            'collaborators[bob]: missing - not a collaborator on the repo; apply will send an invitation with "push"',
          ],
          change: 're-invited collaborator "bob" (push) - the pending invitation had expired',
        },
        {
          role: "cancelInvitation",
          params: { invitation_id: "9" },
          drift: [
            "collaborators[mallory]: undeclared - a pending invitation not in the settings file, so apply will CANCEL it; add them to the settings file to keep the invitation",
          ],
          change: 'CANCELLED undeclared invitation for "mallory"',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test("a declared custom role is noted against a pending invitation, never PATCHed; once expired it is still cancelled and re-sent", async () => {
    const pending = new MockApi({
      [LIST]: { data: [] },
      [INVITATIONS]: {
        data: [{ id: 11, invitee: { login: "alice" }, permissions: "write", expired: false }],
      },
    });
    expect(await plan(pending, [{ username: "alice", permission: "security-team" }])).toEqual({
      ops: [],
      notes: [
        'invitation for "alice" is pending; invitations report only the standard roles, so it cannot be compared to the declared custom role "security-team" - left untouched, the declared role is applied once the invitation is accepted',
      ],
      drift: [],
    });
    const expired = new MockApi({
      [LIST]: { data: [] },
      [INVITATIONS]: {
        data: [{ id: 12, invitee: { login: "alice" }, permissions: "write", expired: true }],
      },
    });
    expect(await plan(expired, [{ username: "alice", permission: "security-team" }])).toEqual({
      ops: [
        {
          role: "cancelInvitation",
          params: { invitation_id: "12" },
          describe: 'cancelling the expired invitation for "alice"',
          drift: [
            'collaborators[alice]: pending invitation expired; apply will cancel it and send a fresh invitation with "security-team"',
          ],
          change: 'cancelled the expired invitation for "alice"',
        },
        {
          role: "update",
          params: { username: "alice" },
          payload: { permission: "security-team" },
          describe: 'inviting collaborator "alice"',
          drift: [
            'collaborators[alice]: missing - not a collaborator on the repo; apply will send an invitation with "security-team"',
          ],
          change:
            're-invited collaborator "alice" (security-team) - the pending invitation had expired',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test("a 404 on the collaborator list is a denial that stops the section before the invitation read", async () => {
    const api = new MockApi({ [INVITATIONS]: { data: [] } });
    deniedDetail(await plan(api, [{ username: "alice" }]).catch((thrown: unknown) => thrown));
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("two entries naming the same login in different case are a validate issue, so the document fails before any API call", () => {
    expect(
      collaboratorsSection.validate([
        { username: "alice" },
        { username: "Alice", permission: "admin" },
      ]),
    ).toEqual([
      {
        path: "[1].username",
        message:
          '"Alice" names the same collaborator as "alice" declared earlier; keep exactly one entry per collaborator',
      },
    ]);
  });

  test("executing the plan against the mock fragment converges: the re-plan carries only the email note", async () => {
    const api = fragmentFake(collaboratorsSection, collaboratorsMockHandlers, {
      collaborators: [
        { login: "alice", role_name: "read" },
        { login: "stale", role_name: "write" },
      ],
      invitations: [
        { id: 501, invitee: { login: "bob" }, permissions: "read" },
        { id: 502, invitee: { login: "carol" }, permissions: "write", expired: true },
        { id: 503, invitee: { login: "mallory" }, permissions: "write" },
        { id: 504, invitee: null, permissions: "read" },
      ],
    });
    const { second, changes, notes } = await provePlanIdempotent(collaboratorsSection, api, [
      { username: "alice", permission: "admin" },
      { username: "bob", permission: "push" },
      { username: "carol", permission: "push" },
      { username: "dave" },
    ]);
    expect(changes).toEqual([
      'updated collaborator "alice" (admin)',
      'updated pending invitation for "bob" (push)',
      'cancelled the expired invitation for "carol"',
      're-invited collaborator "carol" (push) - the pending invitation had expired',
      'invited collaborator "dave" (push)',
      'REMOVED undeclared collaborator "stale"',
      'CANCELLED undeclared invitation for "mallory"',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "PUT /repos/o/r/collaborators/alice",
      "PATCH /repos/o/r/invitations/501",
      "DELETE /repos/o/r/invitations/502",
      "PUT /repos/o/r/collaborators/carol",
      "PUT /repos/o/r/collaborators/dave",
      "DELETE /repos/o/r/collaborators/stale",
      "DELETE /repos/o/r/invitations/503",
    ]);
    expect(second).toEqual({
      ops: [],
      notes: [
        "invitation 504 was sent by email, so no username can declare it; left untouched - cancel it from the repository's Access settings if it is unwanted",
      ],
      drift: [],
    });
    expect(api.state.collaborators.map((c) => [c.login, c.role_name])).toEqual([
      ["alice", "admin"],
    ]);
    expect(
      api.state.invitations.map((i) => [
        (i.invitee as { login?: string } | null)?.login,
        i.permissions,
      ]),
    ).toEqual([
      ["bob", "write"],
      [undefined, "read"],
      ["carol", "write"],
      ["dave", "write"],
    ]);
  });

  describe("snapshot", () => {
    test("only the owner, an expired invitation, and an email invitation snapshot as nothing to declare; the expired note says apply leaves it", async () => {
      const api = new MockApi({
        [LIST]: { data: [{ login: "o", role_name: "admin" }] },
        [INVITATIONS]: {
          data: [
            { id: 8, invitee: { login: "erin" }, permissions: "read", expired: true },
            { id: 9, invitee: null, permissions: "read", expired: false },
          ],
        },
      });
      expect(await snapshot(api)).toEqual({
        value: undefined,
        notes: [
          "collaborators[o]: left out of the snapshot - the repository owner's access is implicit and never managed",
          "collaborators[erin]: left out of the snapshot - the pending invitation has expired; nothing else is declared, so the section is omitted and apply leaves it - declare the entry to re-invite them",
          "collaborators[invitation 9]: left out of the snapshot - sent by email, so no username can declare it; apply leaves it untouched",
        ],
      });
    });

    test("a collaborator or invitation without a role, or with a role no declaration plans as, fails loudly instead of declaring a guess", async () => {
      const roleless = new MockApi({
        [LIST]: { data: [{ login: "alice" }] },
        [INVITATIONS]: { data: [] },
      });
      await expect(snapshot(roleless)).rejects.toThrow(
        "collaborators[alice]: GitHub reported no role_name for this collaborator, so their permission cannot be read back",
      );
      const blankInvitation = new MockApi({
        [LIST]: { data: [] },
        [INVITATIONS]: { data: [{ id: 7, invitee: { login: "dave" }, expired: false }] },
      });
      await expect(snapshot(blankInvitation)).rejects.toThrow(
        "collaborators[dave]: GitHub reported no permissions on the pending invitation, so it cannot be read back",
      );
      // A custom role named "push": declaring "push" plans the write role, so the entry can never converge.
      const collision = new MockApi({
        [LIST]: { data: [{ login: "frank", role_name: "push" }] },
        [INVITATIONS]: { data: [] },
      });
      await expect(snapshot(collision)).rejects.toThrow(
        'collaborators[frank]: the live role "push" has no declaration that plans as itself ("push" in a settings file means the "write" role), so it cannot be read back',
      );
    });
  });
});
