/**
 * The collaborators section's mock handler fragment (see
 * test/e2e/mock/sections.ts for the aggregation and the deliberate
 * src -> test import direction).
 */

import {
  collaboratorFromPut,
  invitationFromPut,
  invitationPermissionFromPut,
} from "../../../test/e2e/mock/state.js";
import {
  asObject,
  type Handler,
  type Json,
  noContent,
  ok,
  slicePage,
} from "../../../test/e2e/mock/support.js";

export const collaboratorsMockHandlers: Record<string, Handler> = {
  "collaborators.list": ({ state, query }) => ok(slicePage(state.collaborators, query)),
  "collaborators.update": ({ state, param, body }) => {
    const username = param("username");
    const existing = state.collaborators.find(
      (c) => String(c.login).toLowerCase() === username.toLowerCase(),
    );
    if (existing) {
      Object.assign(existing, collaboratorFromPut(username, asObject(body)));
      return noContent(); // 204: already a collaborator, access updated
    }
    // Matching real GitHub, a PUT for a non-collaborator does NOT grant
    // access: it creates (or refreshes) a pending invitation and answers 201
    // with the repository-invitation body, whose `permissions` is a STRING
    // (read/write/admin/...), not the collaborator role object. The user
    // joins state.collaborators only in a scenario that seeds them there.
    const pending = state.invitations.find(
      (i) =>
        String((i.invitee as Json | undefined)?.login).toLowerCase() === username.toLowerCase(),
    );
    if (pending) {
      pending.permissions = invitationPermissionFromPut(asObject(body));
      pending.expired = false; // a re-PUT refreshes the invitation
      return { status: 201, body: pending };
    }
    const stored = invitationFromPut(
      username,
      asObject(body),
      state.nextId++,
      state.repo,
      state.slug,
    );
    state.invitations.push(stored);
    return { status: 201, body: stored };
  },
  "collaborators.remove": ({ state, param }) => {
    const username = param("username");
    const index = state.collaborators.findIndex(
      (c) => String(c.login).toLowerCase() === username.toLowerCase(),
    );
    if (index >= 0) {
      state.collaborators.splice(index, 1);
    }
    return noContent();
  },
  "collaborators.listInvitations": ({ state, query }) => ok(slicePage(state.invitations, query)),
  "collaborators.updateInvitation": ({ state, param, body }) => {
    const id = param("invitation_id");
    const invitation = state.invitations.find((i) => String(i.id) === id);
    if (!invitation) {
      return { status: 404, body: { message: "Not Found" } };
    }
    // The PATCH speaks the invitation's own read vocabulary (read/write/...),
    // so the body's `permissions` is stored verbatim.
    const permissions = asObject(body).permissions;
    if (permissions !== undefined) {
      invitation.permissions = permissions;
    }
    return ok(invitation);
  },
  "collaborators.cancelInvitation": ({ state, param }) => {
    const id = param("invitation_id");
    const index = state.invitations.findIndex((i) => String(i.id) === id);
    if (index >= 0) {
      state.invitations.splice(index, 1);
    }
    return noContent();
  },
};
