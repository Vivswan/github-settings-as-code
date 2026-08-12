/**
 * `collaborators:` section - direct collaborators keyed by username, with
 * pending repository invitations reconciled alongside them: a declared user
 * whose invitation is still pending converges (or gets the invitation
 * updated/re-sent), instead of being re-invited forever. Undeclared
 * collaborators are REMOVED and undeclared invitations cancelled by default
 * (the owner never is); the wrapped `undeclared: keep` form softens both to
 * notes.
 */

import { z } from "zod";
import { SettingsFile } from "../../schema.js";
import {
  beginRun,
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  listAll,
  loosen,
  parseLive,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract.js";
import { DEFAULT_ROLE, INVITATION_ROLES, roleForPermission } from "../roles.js";

/** The fields of a live collaborator this section reads; extras ride along. */
const LiveCollaborator = z.looseObject({
  login: z.string(),
  permissions: z.record(z.string(), z.boolean()).optional(),
  role_name: z.string().optional(),
});

/**
 * A pending repository invitation as the list endpoint returns it. Its
 * `permissions` field speaks the READ vocabulary (read/write/...), the same
 * one roleForPermission maps declared permissions into. `invitee` is null on
 * invitations sent by email, which no username can declare.
 */
const LiveInvitation = z.looseObject({
  id: z.number(),
  invitee: z.looseObject({ login: z.string().optional() }).nullable().optional(),
  permissions: z.string().optional(),
  expired: z.boolean().optional(),
});
type LiveInvitation = z.infer<typeof LiveInvitation>;

/** An invitation PROVEN username-addressed: the type carries the login. */
type NamedInvitation = LiveInvitation & { invitee: { login: string } };

/**
 * The partition predicate: a NON-EMPTY string login on purpose, so an
 * empty-string login stays in the email pool exactly as the runtime filter
 * always treated it, and an off-contract non-string login can never reach
 * the named pool's string operations.
 */
function isNamedInvitation(invitation: LiveInvitation): invitation is NamedInvitation {
  return typeof invitation.invitee?.login === "string" && invitation.invitee.login !== "";
}

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/collaborators",
    statuses: { 200: "the direct-collaborator list" },
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

export const collaboratorsSection = {
  key: "collaborators",
  undeclaredDefault: "delete",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(SettingsFile.shape.collaborators),
  // Closed surface: the PUT accepts exactly one setting ("permission"), so
  // an extra key is always a typo - and a misspelled "permission" would
  // silently grant the default role and report clean forever.
  closedSurface: {
    known: { username: true, permission: true },
    describe: (c) => c.username,
    consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`,
  },
  async run(ctx, declared): Promise<SectionResult> {
    const run = beginRun(ctx);
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    rejectDuplicates(
      this,
      desired,
      (c) => c.username.toLowerCase(),
      (c) => c.username,
    );
    const live = parseLive(
      this,
      ENDPOINTS.list,
      z.array(LiveCollaborator),
      await listAll(ctx, this, ENDPOINTS.list, { query: { affiliation: "direct" } }),
    );
    const liveByLogin = new Map(live.map((c) => [c.login.toLowerCase(), c]));
    // Both live pools are resolved BEFORE the declared walk, so a declared
    // user is never mistaken for undeclared in the other pool. The type
    // predicate PARTITIONS the invitations once: the username-addressed pool
    // carries its logins structurally, and email invitations (null invitee,
    // which no username can declare) split into their own pool.
    const allInvitations = parseLive(
      this,
      ENDPOINTS.listInvitations,
      z.array(LiveInvitation),
      await listAll(ctx, this, ENDPOINTS.listInvitations),
    );
    const invitations = allInvitations.filter(isNamedInvitation);
    const emailInvitations = allInvitations.filter((invitation) => !isNamedInvitation(invitation));
    const inviteByLogin = new Map(
      invitations.map((invitation) => [invitation.invitee.login.toLowerCase(), invitation]),
    );
    const declaredKeys = new Set<string>();

    for (const collaborator of desired) {
      const login = collaborator.username.toLowerCase();
      declaredKeys.add(login);
      const wantPermission = collaborator.permission ?? DEFAULT_ROLE;
      const wantRole = roleForPermission(wantPermission);
      const existing = liveByLogin.get(login);
      if (existing) {
        // On GitHub a user is never a collaborator AND an invitee at once,
        // so the collaborator branch settles the entry.
        if ((existing.role_name ?? "") === wantRole) {
          continue;
        }
        if (run.check) {
          run.result.drift.push(
            `collaborators[${collaborator.username}]: live role "${existing.role_name}" != declared "${wantRole}"; apply will set the declared permission`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.update, {
            params: { username: collaborator.username },
            payload: { permission: wantPermission },
            describe: `updating collaborator "${collaborator.username}"`,
          });
          run.result.changes.push(
            `updated collaborator "${collaborator.username}" (${wantPermission})`,
          );
        }
        continue;
      }
      const invitation = inviteByLogin.get(login);
      if (invitation && invitation.expired !== true) {
        if (!INVITATION_ROLES.has(wantRole)) {
          // Invitations carry only the standard roles, so a declared custom
          // role can never be verified against (or PATCHed onto) a pending
          // one. Cancelling and re-inviting would just repeat forever, so
          // leave it: the declared role applies through the regular
          // collaborator path once the invitation is accepted.
          run.result.notes.push(
            `invitation for "${collaborator.username}" is pending; invitations report only the standard roles, so it cannot be compared to the declared custom role "${wantPermission}" - left untouched, the declared role is applied once the invitation is accepted`,
          );
          continue;
        }
        if ((invitation.permissions ?? "") === wantRole) {
          continue; // the pending invitation already grants the declared permission
        }
        if (run.check) {
          run.result.drift.push(
            `collaborators[${collaborator.username}]: pending invitation permission "${invitation.permissions}" != declared "${wantRole}"; apply will update the invitation`,
          );
          continue;
        }
        // The invitation PATCH speaks the READ vocabulary, so it takes the
        // mapped role, not the declared permission.
        await call(ctx, this, ENDPOINTS.updateInvitation, {
          params: { invitation_id: String(invitation.id) },
          payload: { permissions: wantRole },
          describe: `updating the pending invitation for "${collaborator.username}"`,
        });
        run.result.changes.push(
          `updated pending invitation for "${collaborator.username}" (${wantPermission})`,
        );
        continue;
      }
      if (run.check) {
        run.result.drift.push(
          invitation
            ? `collaborators[${collaborator.username}]: pending invitation expired; apply will cancel it and send a fresh invitation with "${wantPermission}"`
            : `collaborators[${collaborator.username}]: missing - not a collaborator on the repo; apply will send an invitation with "${wantPermission}"`,
        );
        continue;
      }
      if (invitation) {
        // An expired invitation cannot be revived by a PATCH; cancel it and
        // let the fresh PUT below mint a new one.
        await call(ctx, this, ENDPOINTS.cancelInvitation, {
          params: { invitation_id: String(invitation.id) },
          describe: `cancelling the expired invitation for "${collaborator.username}"`,
        });
      }
      await call(ctx, this, ENDPOINTS.update, {
        params: { username: collaborator.username },
        payload: { permission: wantPermission },
        describe: `inviting collaborator "${collaborator.username}"`,
      });
      run.result.changes.push(
        invitation
          ? `re-invited collaborator "${collaborator.username}" (${wantPermission}) - the pending invitation had expired`
          : `invited collaborator "${collaborator.username}" (${wantPermission})`,
      );
    }

    for (const collaborator of live) {
      const login = collaborator.login.toLowerCase();
      if (login === ctx.repo.owner.toLowerCase() || declaredKeys.has(login)) {
        continue; // never remove the owner (under either policy)
      }
      if (policy === "keep") {
        run.result.notes.push(
          undeclaredNote({
            subject: `collaborator "${collaborator.login}"`,
            state: "has access but is not declared",
            add: "them",
            manage: "their access",
            action: "REMOVE them",
          }),
        );
      } else if (run.check) {
        run.result.drift.push(
          undeclaredDrift(defaultUndeclaredPolicy(this), {
            label: `collaborators[${collaborator.login}]`,
            action: "REMOVE them",
            add: "them",
            keep: "their access",
          }),
        );
      } else {
        await call(ctx, this, ENDPOINTS.remove, {
          params: { username: collaborator.login },
        });
        run.result.changes.push(`REMOVED undeclared collaborator "${collaborator.login}"`);
      }
    }

    for (const invitation of invitations) {
      const invitee = invitation.invitee.login;
      if (declaredKeys.has(invitee.toLowerCase())) {
        continue;
      }
      if (policy === "keep") {
        run.result.notes.push(
          undeclaredNote({
            subject: `invitation for "${invitee}"`,
            state: "is pending but not declared",
            add: "them",
            manage: "their access",
            action: "CANCEL the invitation",
          }),
        );
      } else if (run.check) {
        run.result.drift.push(
          undeclaredDrift(defaultUndeclaredPolicy(this), {
            label: `collaborators[${invitee}]`,
            state: "a pending invitation not in the settings file",
            action: "CANCEL it",
            add: "them",
            keep: "the invitation",
          }),
        );
      } else {
        await call(ctx, this, ENDPOINTS.cancelInvitation, {
          params: { invitation_id: String(invitation.id) },
        });
        run.result.changes.push(`CANCELLED undeclared invitation for "${invitee}"`);
      }
    }

    for (const invitation of emailInvitations) {
      run.result.notes.push(
        `invitation ${invitation.id} was sent by email, so no username can declare it; left untouched - cancel it from the repository's Access settings if it is unwanted`,
      );
    }
    return run.result;
  },
} satisfies SectionModule<"collaborators">;
