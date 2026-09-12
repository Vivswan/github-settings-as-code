/** `collaborators:` section: direct collaborators by username plus their pending invitations; the owner is never removed. */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  loosen,
  type SectionMeta,
  type SectionModule,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlanContext, PlannedOp, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import {
  DEFAULT_ROLE,
  INVITATION_ROLES,
  permissionForRole,
  roleForPermission,
} from "../shared/roles.js";
import { knobbed } from "../shared/schema-helpers.js";
import { knobbedSnapshot } from "../shared/snapshot-helpers.js";
import { CollaboratorConfig } from "./schema.js";

const LiveCollaborator = z.looseObject({
  login: z.string(),
  permissions: z.record(z.string(), z.boolean()).optional(),
  role_name: z.string().optional(),
});
type LiveCollaborator = z.infer<typeof LiveCollaborator>;

// `permissions` speaks the READ vocabulary (read/write/...) that roleForPermission maps declared
// permissions into; `invitee` is null on email invitations.
const LiveInvitation = z.looseObject({
  id: z.number(),
  invitee: z.looseObject({ login: z.string().optional() }).nullable().optional(),
  permissions: z.string().optional(),
  expired: z.boolean().optional(),
});
type LiveInvitation = z.infer<typeof LiveInvitation>;

type NamedInvitation = LiveInvitation & { invitee: { login: string } };

function isNamedInvitation(invitation: LiveInvitation): invitation is NamedInvitation {
  return typeof invitation.invitee?.login === "string" && invitation.invitee.login !== "";
}

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/collaborators",
    statuses: { 200: "the direct-collaborator list" },
    primaryRead: { notFound: "denied" },
  },
  update: {
    route: "PUT /repos/{owner}/{repo}/collaborators/{username}",
    statuses: { 201: "invitation created", 204: "collaborator already had the access" },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/collaborators/{username}",
    statuses: { 204: "collaborator removed" },
  },
  listInvitations: {
    route: "GET /repos/{owner}/{repo}/invitations",
    statuses: { 200: "the pending-invitation list" },
  },
  updateInvitation: {
    route: "PATCH /repos/{owner}/{repo}/invitations/{invitation_id}",
    statuses: { 200: "invitation permission updated" },
  },
  cancelInvitation: {
    route: "DELETE /repos/{owner}/{repo}/invitations/{invitation_id}",
    statuses: { 204: "invitation cancelled" },
  },
} as const satisfies Record<string, EndpointDecl>;

type CollaboratorsContext = PlanContext<typeof ENDPOINTS>;

/** The permission a live role declares as; a role no declaration plans as fails loudly. */
function declaredPermission(label: string, role: string): string {
  const permission = permissionForRole(role);
  if (permission === undefined) {
    throw new Error(
      `${label}: the live role "${role}" has no declaration that plans as itself ("${role}" in a settings file means the "${roleForPermission(role)}" role), so it cannot be read back`,
    );
  }
  return permission;
}

/** Both pools in one read, so plan() and snapshot() see the same live access. */
async function readLiveAccess(
  ctx: CollaboratorsContext,
  section: SectionMeta,
): Promise<{
  collaborators: LiveCollaborator[];
  invitations: NamedInvitation[];
  emailInvitations: LiveInvitation[];
}> {
  const collaborators = parseLive(
    section,
    ENDPOINTS.list,
    z.array(LiveCollaborator),
    await ctx.read.list.listAll({ query: { affiliation: "direct" } }),
  );
  const allInvitations = parseLive(
    section,
    ENDPOINTS.listInvitations,
    z.array(LiveInvitation),
    await ctx.read.listInvitations.listAll(),
  );
  return {
    collaborators,
    invitations: allInvitations.filter(isNamedInvitation),
    emailInvitations: allInvitations.filter((invitation) => !isNamedInvitation(invitation)),
  };
}

function isOwner(ctx: CollaboratorsContext, login: string): boolean {
  return login.toLowerCase() === ctx.repo.owner.toLowerCase();
}

function emailInvitationNote(invitation: LiveInvitation, outcome: string): string {
  return `invitation ${invitation.id} was sent by email, so no username can declare it; ${outcome}`;
}

export const collaboratorsSection = {
  key: "collaborators",
  undeclaredDefault: "delete",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(knobbed(CollaboratorConfig)),
  // The PUT accepts exactly one setting ("permission"), so an extra key is always a typo.
  closedSurface: {
    known: { username: true, permission: true },
    describe: (c) => c.username,
    consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`,
  },
  async plan(ctx, declared) {
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    rejectDuplicates(
      this,
      desired,
      (c) => c.username.toLowerCase(),
      (c) => c.username,
    );
    // Both pools are resolved BEFORE the declared walk, so a declared user is never mistaken for
    // undeclared in the other pool; email invitations (null invitee, which no username can declare)
    // split into their own pool.
    const { collaborators: live, invitations, emailInvitations } = await readLiveAccess(ctx, this);
    const liveByLogin = new Map(live.map((c) => [c.login.toLowerCase(), c]));
    const inviteByLogin = new Map(
      invitations.map((invitation) => [invitation.invitee.login.toLowerCase(), invitation]),
    );
    const declaredKeys = new Set<string>();
    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };

    for (const collaborator of desired) {
      const { username } = collaborator;
      const login = username.toLowerCase();
      declaredKeys.add(login);
      const wantPermission = collaborator.permission ?? DEFAULT_ROLE;
      const wantRole = roleForPermission(wantPermission);
      const label = `collaborators[${username}]`;
      const existing = liveByLogin.get(login);
      if (existing) {
        // On GitHub a user is never a collaborator AND an invitee at once, so this branch settles the entry.
        if ((existing.role_name ?? "") !== wantRole) {
          plan.ops.push({
            role: "update",
            params: { username },
            payload: { permission: wantPermission },
            describe: `updating collaborator "${username}"`,
            drift: [
              `${label}: live role "${existing.role_name}" != declared "${wantRole}"; apply will set the declared permission`,
            ],
            change: `updated collaborator "${username}" (${wantPermission})`,
          });
        }
        continue;
      }
      const invitation = inviteByLogin.get(login);
      if (invitation && invitation.expired !== true) {
        if (!INVITATION_ROLES.has(wantRole)) {
          // Invitations carry only the standard roles, so a declared custom role can neither be
          // verified against nor PATCHed onto a pending one; it applies once the invitation is accepted.
          plan.notes.push(
            `invitation for "${username}" is pending; invitations report only the standard roles, so it cannot be compared to the declared custom role "${wantPermission}" - left untouched, the declared role is applied once the invitation is accepted`,
          );
          continue;
        }
        if ((invitation.permissions ?? "") !== wantRole) {
          // The invitation PATCH speaks the READ vocabulary, so it takes the mapped role, not the declared permission.
          plan.ops.push({
            role: "updateInvitation",
            params: { invitation_id: String(invitation.id) },
            payload: { permissions: wantRole },
            describe: `updating the pending invitation for "${username}"`,
            drift: [
              `${label}: pending invitation permission "${invitation.permissions}" != declared "${wantRole}"; apply will update the invitation`,
            ],
            change: `updated pending invitation for "${username}" (${wantPermission})`,
          });
        }
        continue;
      }
      if (invitation) {
        // An expired invitation cannot be revived by a PATCH: cancel it, and the PUT below mints a fresh one.
        plan.ops.push({
          role: "cancelInvitation",
          params: { invitation_id: String(invitation.id) },
          describe: `cancelling the expired invitation for "${username}"`,
          drift: [
            `${label}: pending invitation expired; apply will cancel it and send a fresh invitation with "${wantPermission}"`,
          ],
          change: `cancelled the expired invitation for "${username}"`,
        });
      }
      plan.ops.push({
        role: "update",
        params: { username },
        payload: { permission: wantPermission },
        describe: `inviting collaborator "${username}"`,
        drift: [
          `${label}: missing - not a collaborator on the repo; apply will send an invitation with "${wantPermission}"`,
        ],
        change: invitation
          ? `re-invited collaborator "${username}" (${wantPermission}) - the pending invitation had expired`
          : `invited collaborator "${username}" (${wantPermission})`,
      });
    }

    for (const collaborator of live) {
      const login = collaborator.login.toLowerCase();
      if (isOwner(ctx, login) || declaredKeys.has(login)) {
        continue;
      }
      if (policy === "keep") {
        plan.notes.push(
          undeclaredNote({
            subject: `collaborator "${collaborator.login}"`,
            state: "has access but is not declared",
            add: "them",
            manage: "their access",
            action: "REMOVE them",
          }),
        );
        continue;
      }
      plan.ops.push({
        role: "remove",
        params: { username: collaborator.login },
        drift: [
          undeclaredDrift(defaultUndeclaredPolicy(this), {
            label: `collaborators[${collaborator.login}]`,
            action: "REMOVE them",
            add: "them",
            keep: "their access",
          }),
        ],
        change: `REMOVED undeclared collaborator "${collaborator.login}"`,
      });
    }

    for (const invitation of invitations) {
      const invitee = invitation.invitee.login;
      if (declaredKeys.has(invitee.toLowerCase())) {
        continue;
      }
      if (policy === "keep") {
        plan.notes.push(
          undeclaredNote({
            subject: `invitation for "${invitee}"`,
            state: "is pending but not declared",
            add: "them",
            manage: "their access",
            action: "CANCEL the invitation",
          }),
        );
        continue;
      }
      plan.ops.push({
        role: "cancelInvitation",
        params: { invitation_id: String(invitation.id) },
        drift: [
          undeclaredDrift(defaultUndeclaredPolicy(this), {
            label: `collaborators[${invitee}]`,
            state: "a pending invitation not in the settings file",
            action: "CANCEL it",
            add: "them",
            keep: "the invitation",
          }),
        ],
        change: `CANCELLED undeclared invitation for "${invitee}"`,
      });
    }

    for (const invitation of emailInvitations) {
      plan.notes.push(
        emailInvitationNote(
          invitation,
          "left untouched - cancel it from the repository's Access settings if it is unwanted",
        ),
      );
    }
    return plan;
  },
  /**
   * Omitted with a note: the owner and email invitations (no-ops for plan()), and expired
   * invitations (plan() cancels an undeclared one; a declared one it would cancel and re-send).
   * A role the snapshot cannot declare fails loudly:
   * dropping the entry would plan a removal, guessing a role would plan a grant.
   */
  async snapshot(ctx) {
    const { collaborators, invitations, emailInvitations } = await readLiveAccess(ctx, this);
    const notes: string[] = [];
    const entries: CollaboratorConfig[] = [];
    const expired: string[] = [];
    for (const collaborator of collaborators) {
      const label = `collaborators[${collaborator.login}]`;
      if (isOwner(ctx, collaborator.login)) {
        notes.push(
          `${label}: the repository owner's access is implicit and never managed, so it is not declared`,
        );
        continue;
      }
      if (collaborator.role_name === undefined) {
        throw new Error(
          `${label}: GitHub reported no role_name for this collaborator, so their permission cannot be read back`,
        );
      }
      entries.push({
        username: collaborator.login,
        permission: declaredPermission(label, collaborator.role_name),
      });
    }
    for (const invitation of invitations) {
      const login = invitation.invitee.login;
      const label = `collaborators[${login}]`;
      if (invitation.expired === true) {
        expired.push(label);
        continue;
      }
      if (invitation.permissions === undefined) {
        throw new Error(
          `${label}: GitHub reported no permissions on the pending invitation, so it cannot be read back`,
        );
      }
      entries.push({
        username: login,
        permission: declaredPermission(label, invitation.permissions),
      });
    }
    // With nothing to declare the section is omitted, so apply never reaches the expired ones.
    const outcome =
      entries.length > 0
        ? "apply cancels it - add the entry to re-invite them"
        : "nothing else is declared, so the section is omitted and apply leaves it - declare the entry to re-invite them";
    for (const label of expired) {
      notes.push(`${label}: the pending invitation has expired, so it is not declared; ${outcome}`);
    }
    for (const invitation of emailInvitations) {
      notes.push(emailInvitationNote(invitation, "not declared, and apply leaves it untouched"));
    }
    if (entries.length === 0) {
      return { value: undefined, notes };
    }
    return { value: knobbedSnapshot(this, entries), notes };
  },
} satisfies SectionModule<"collaborators", typeof ENDPOINTS>;
