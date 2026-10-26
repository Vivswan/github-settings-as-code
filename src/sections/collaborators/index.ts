/**
 * `collaborators:` section: direct collaborators by username plus their pending invitations; the owner is
 * never removed. Bespoke, not on listSection: one declared username resolves against two live pools (the
 * collaborator list and the pending invitations), each with its own writes.
 */

import { err, ok, type Result, safeTry } from "neverthrow";
import { z } from "zod";
import { INVITATION_ROLES } from "../../generated/spec-roles.js";
import type { UndeclaredPolicy } from "../../types.js";
import {
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
  valueDrift,
} from "../contract/drift.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { type SectionFailure, sectionFailure } from "../contract/errors.js";
import { identifiedBy } from "../contract/keyed-list.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  type SectionMeta,
  type SectionModule,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlanContext, PlannedOp, Read, SectionPlan } from "../contract/plan.js";
import { DEFAULT_ROLE, readBackPermission, roleForPermission } from "../shared/roles.js";
import { knobbed, routed } from "../shared/schema-helpers.js";
import { knobbedSnapshot, leftOutOfSnapshot } from "../shared/snapshot-helpers.js";
import { CollaboratorConfig } from "./schema.js";

const LiveCollaborator = z.looseObject({
  login: z.string(),
  permissions: z.record(z.string(), z.boolean()).optional(),
  role_name: z.string().optional(),
});
type LiveCollaborator = z.infer<typeof LiveCollaborator>;

const LiveInvitation = z.looseObject({
  id: z.number(),
  // null on an email invitation
  invitee: z.looseObject({ login: z.string().optional() }).nullable().optional(),
  // The READ vocabulary (read/write/...), which roleForPermission maps declared permissions into.
  permissions: z.string().optional(),
  expired: z.boolean().optional(),
});
type LiveInvitation = z.infer<typeof LiveInvitation>;

type NamedInvitation = LiveInvitation & { invitee: { login: string } };

function isNamedInvitation(invitation: LiveInvitation): invitation is NamedInvitation {
  return typeof invitation.invitee?.login === "string" && invitation.invitee.login !== "";
}

declare const collaboratorLoginKey: unique symbol;

/** GitHub matches logins case-insensitively; the brand marks a login already folded to the key every lookup reads. */
type LoginKey = string & { readonly [collaboratorLoginKey]: true };

function loginKey(login: string): LoginKey {
  return login.toLowerCase() as LoginKey;
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
type CollaboratorsPlan = SectionPlan<PlannedOp<typeof ENDPOINTS>>;

/** Both live pools, indexed; the email invitations (a null invitee, which no username can declare) are a pool of their own. */
interface LiveAccess {
  collaborators: LiveCollaborator[];
  liveByLogin: Map<LoginKey, LiveCollaborator>;
  invitations: NamedInvitation[];
  inviteByLogin: Map<LoginKey, NamedInvitation>;
  emailInvitations: LiveInvitation[];
}

/** A declared entry as the writes spell it: the permission the PUT takes, and the role GitHub reads it back as. */
interface Wanted {
  readonly username: string;
  readonly permission: string;
  readonly role: string;
}

/** What the undeclared walks share: who is declared, and what the policy says to do with everyone else. */
interface Undeclared {
  readonly declaredKeys: ReadonlySet<LoginKey>;
  readonly policy: UndeclaredPolicy;
  readonly listDefault: UndeclaredPolicy;
}

/** Both pools in one read, each indexed under the guard, so plan() and snapshot() see the same live access. */
function readLiveAccess(ctx: CollaboratorsContext, section: SectionMeta): Read<LiveAccess> {
  return safeTry(async function* () {
    const collaborators = yield* ctx.read.list.listAll(LiveCollaborator, {
      query: { affiliation: "direct" },
    });
    const allInvitations = yield* ctx.read.listInvitations.listAll(LiveInvitation);
    const invitations = allInvitations.filter(isNamedInvitation);
    const liveByLogin = yield* liveByIdentity(
      section,
      "collaborator",
      collaborators,
      (c) => loginKey(c.login),
      (c) => liveIdentity(c.login),
    );
    const inviteByLogin = yield* liveByIdentity(
      section,
      "pending invitation",
      invitations,
      (invitation) => loginKey(invitation.invitee.login),
      (invitation) => liveIdentity(invitation.invitee.login, { invitation_id: invitation.id }),
    );
    return ok({
      collaborators,
      liveByLogin,
      invitations,
      inviteByLogin,
      emailInvitations: allInvitations.filter((invitation) => !isNamedInvitation(invitation)),
    });
  });
}

function isOwner(ctx: CollaboratorsContext, login: LoginKey): boolean {
  return login === loginKey(ctx.repo.owner);
}

/** The update for a declared entry already a collaborator, when its live role differs. */
function settleCollaborator(
  wanted: Wanted,
  existing: LiveCollaborator,
  plan: CollaboratorsPlan,
): void {
  if ((existing.role_name ?? "") === wanted.role) {
    return;
  }

  plan.ops.push({
    role: "update",
    params: { username: wanted.username },
    payload: { permission: wanted.permission },
    describe: `updating collaborator "${wanted.username}"`,
    drift: [
      valueDrift(
        `collaborators[${wanted.username}]`,
        JSON.stringify(wanted.role),
        JSON.stringify(existing.role_name),
        { remedy: "apply will set the declared permission" },
      ),
    ],
    change: `updated collaborator "${wanted.username}" (${wanted.permission})`,
  });
}

/** The op or note for a declared entry whose live state is an unexpired pending invitation. */
function settlePendingInvitation(
  wanted: Wanted,
  invitation: NamedInvitation,
  plan: CollaboratorsPlan,
): void {
  const { username } = wanted;
  if ((invitation.permissions ?? "") === wanted.role) {
    return;
  }

  if (!INVITATION_ROLES.has(wanted.role)) {
    // A custom role never appears on an invitation, and the PATCH's enum (src/generated/spec-roles.ts) can lag
    // the GET's, so neither can be set on a pending one; the PUT applies it once the invitation is accepted.
    const settable = [...INVITATION_ROLES].join(", ");
    plan.notes.push(
      `invitation for "${username}" is pending; the invitation PATCH accepts only ${settable}, ` +
        `so "${wanted.permission}" cannot be set on it - left untouched, the next apply grants it once the invitation is accepted`,
    );
    return;
  }

  // The invitation PATCH speaks the READ vocabulary, so it takes the mapped role, not the declared permission.
  plan.ops.push({
    role: "updateInvitation",
    params: { invitation_id: String(invitation.id) },
    payload: { permissions: wanted.role },
    describe: `updating the pending invitation for "${username}"`,
    drift: [
      valueDrift(
        `collaborators[${username}] (pending invitation)`,
        JSON.stringify(wanted.role),
        JSON.stringify(invitation.permissions),
        { remedy: "apply will update the invitation" },
      ),
    ],
    change: `updated pending invitation for "${username}" (${wanted.permission})`,
  });
}

/** The invitation for a declared entry with no live access, an expired invitation cancelled first. */
function inviteDeclared(
  wanted: Wanted,
  expired: NamedInvitation | undefined,
  plan: CollaboratorsPlan,
): void {
  const { username } = wanted;
  const label = `collaborators[${username}]`;
  if (expired) {
    // An expired invitation cannot be revived by a PATCH: cancel it, and the PUT below mints a fresh one.
    plan.ops.push({
      role: "cancelInvitation",
      params: { invitation_id: String(expired.id) },
      describe: `cancelling the expired invitation for "${username}"`,
      drift: [
        `${label}: pending invitation expired; apply will cancel it and send a fresh invitation with "${wanted.permission}"`,
      ],
      change: `cancelled the expired invitation for "${username}"`,
    });
  }

  plan.ops.push({
    role: "update",
    params: { username },
    payload: { permission: wanted.permission },
    describe: `inviting collaborator "${username}"`,
    drift: [
      `${label}: missing - not a collaborator on the repo; apply will send an invitation with "${wanted.permission}"`,
    ],
    change: expired
      ? `re-invited collaborator "${username}" (${wanted.permission}) - the pending invitation had expired`
      : `invited collaborator "${username}" (${wanted.permission})`,
  });
}

/** One declared entry settled against the collaborator it already is, else its pending invitation, else invited. */
function settleDeclared(
  collaborator: CollaboratorConfig,
  access: LiveAccess,
  plan: CollaboratorsPlan,
): void {
  const permission = collaborator.permission ?? DEFAULT_ROLE;
  const wanted: Wanted = {
    username: collaborator.username,
    permission,
    role: roleForPermission(permission),
  };
  const login = loginKey(collaborator.username);

  const existing = access.liveByLogin.get(login);
  if (existing) {
    // On GitHub a user is never a collaborator AND an invitee at once, so this branch settles the entry.
    settleCollaborator(wanted, existing, plan);
    return;
  }

  const invitation = access.inviteByLogin.get(login);
  if (invitation && invitation.expired !== true) {
    settlePendingInvitation(wanted, invitation, plan);
    return;
  }

  inviteDeclared(wanted, invitation, plan);
}

/** A removal per live collaborator neither the owner nor declared, or a note each under the keep policy. */
function planUndeclaredCollaborators(
  ctx: CollaboratorsContext,
  live: readonly LiveCollaborator[],
  undeclared: Undeclared,
  plan: CollaboratorsPlan,
): void {
  for (const collaborator of live) {
    const login = loginKey(collaborator.login);
    if (isOwner(ctx, login) || undeclared.declaredKeys.has(login)) {
      continue;
    }

    if (undeclared.policy === "keep") {
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
        undeclaredDrift(undeclared.listDefault, {
          label: `collaborators[${collaborator.login}]`,
          action: "REMOVE them",
          add: "them",
          keep: "their access",
        }),
      ],
      change: `REMOVED undeclared collaborator "${collaborator.login}"`,
    });
  }
}

/** A cancellation per pending invitation nobody declared, or a note each under the keep policy. */
function planUndeclaredInvitations(
  invitations: readonly NamedInvitation[],
  undeclared: Undeclared,
  plan: CollaboratorsPlan,
): void {
  for (const invitation of invitations) {
    const invitee = invitation.invitee.login;
    if (undeclared.declaredKeys.has(loginKey(invitee))) {
      continue;
    }

    if (undeclared.policy === "keep") {
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
        undeclaredDrift(undeclared.listDefault, {
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
}

/** The snapshot entries of the direct collaborators; the owner is left out with a note, and a role GitHub does not report fails. */
function collaboratorEntries(
  ctx: CollaboratorsContext,
  section: SectionMeta,
  collaborators: readonly LiveCollaborator[],
  notes: string[],
): Result<CollaboratorConfig[], SectionFailure> {
  return safeTry(function* () {
    const entries: CollaboratorConfig[] = [];
    for (const collaborator of collaborators) {
      const label = `collaborators[${collaborator.login}]`;
      if (isOwner(ctx, loginKey(collaborator.login))) {
        notes.push(
          leftOutOfSnapshot(label, "the repository owner's access is implicit and never managed"),
        );
        continue;
      }

      if (collaborator.role_name === undefined) {
        return err(
          sectionFailure(
            "live-shape",
            `${label}: GitHub reported no role_name for this collaborator, so their permission cannot be read back`,
          ),
        );
      }

      // The section deletes undeclared access, so readBackPermission fails rather than notes here.
      const permission = yield* readBackPermission(section, label, collaborator.role_name, notes);
      if (permission !== undefined) {
        entries.push({ username: collaborator.login, permission });
      }
    }

    return ok(entries);
  });
}

/** The snapshot entries of the pending invitations, the expired ones set aside by label; a missing permission fails. */
function invitationEntries(
  section: SectionMeta,
  invitations: readonly NamedInvitation[],
  notes: string[],
): Result<{ entries: CollaboratorConfig[]; expired: string[] }, SectionFailure> {
  return safeTry(function* () {
    const entries: CollaboratorConfig[] = [];
    const expired: string[] = [];
    for (const invitation of invitations) {
      const login = invitation.invitee.login;
      const label = `collaborators[${login}]`;
      if (invitation.expired === true) {
        expired.push(label);
        continue;
      }

      if (invitation.permissions === undefined) {
        return err(
          sectionFailure(
            "live-shape",
            `${label}: GitHub reported no permissions on the pending invitation, so it cannot be read back`,
          ),
        );
      }

      const permission = yield* readBackPermission(section, label, invitation.permissions, notes);
      if (permission !== undefined) {
        entries.push({ username: login, permission });
      }
    }

    return ok({ entries, expired });
  });
}

export const collaboratorsSection = {
  ...identifiedBy("collaborators", "username", "collaborator", { fold: loginKey }),
  undeclaredDefault: "delete",
  permission,
  endpoints: ENDPOINTS,
  shape: routed(knobbed(CollaboratorConfig)),
  // The PUT accepts exactly one setting ("permission"), so an extra key is always a typo.
  closedSurface: {
    known: { username: true, permission: true },
    consequence: `a misspelled "permission" key would silently grant the default "${DEFAULT_ROLE}" role instead of the intended one`,
  },
  async plan(ctx, declared) {
    const listDefault = defaultUndeclaredPolicy(this);
    const { policy, entries: desired } = undeclaredPolicy(declared, listDefault);
    // Both pools are resolved BEFORE the declared walk, so a declared user is never mistaken for
    // undeclared in the other pool.
    return readLiveAccess(ctx, this).map((access) => {
      const plan: CollaboratorsPlan = { ops: [], notes: [], drift: [] };
      const declaredKeys = new Set<LoginKey>();
      for (const collaborator of desired) {
        declaredKeys.add(loginKey(collaborator.username));
        settleDeclared(collaborator, access, plan);
      }

      const undeclared: Undeclared = { declaredKeys, policy, listDefault };
      planUndeclaredCollaborators(ctx, access.collaborators, undeclared, plan);
      planUndeclaredInvitations(access.invitations, undeclared, plan);
      for (const invitation of access.emailInvitations) {
        plan.notes.push(
          `invitation ${invitation.id} was sent by email, so no username can declare it; left untouched - cancel it from the repository's Access settings if it is unwanted`,
        );
      }

      return plan;
    });
  },
  /**
   * Omitted with a note: the owner and email invitations (no-ops for plan()), and expired
   * invitations (plan() cancels an undeclared one; a declared one it would cancel and re-send).
   * A role the snapshot cannot declare fails loudly:
   * dropping the entry would plan a removal, guessing a role would plan a grant.
   */
  async snapshot(ctx) {
    const section = this;
    return readLiveAccess(ctx, section).andThen(
      ({ collaborators, invitations, emailInvitations }) =>
        safeTry(function* () {
          const notes: string[] = [];
          const entries = yield* collaboratorEntries(ctx, section, collaborators, notes);
          const pending = yield* invitationEntries(section, invitations, notes);
          entries.push(...pending.entries);

          // With nothing to declare the section is omitted, so apply never reaches the expired ones.
          const outcome =
            entries.length > 0
              ? "apply cancels it - add the entry to re-invite them"
              : "nothing else is declared, so the section is omitted and apply leaves it - declare the entry to re-invite them";
          for (const label of pending.expired) {
            notes.push(leftOutOfSnapshot(label, `the pending invitation has expired; ${outcome}`));
          }
          for (const invitation of emailInvitations) {
            notes.push(
              leftOutOfSnapshot(
                `collaborators[invitation ${invitation.id}]`,
                "sent by email, so no username can declare it; apply leaves it untouched",
              ),
            );
          }

          if (entries.length === 0) {
            return ok({ value: undefined, notes });
          }
          return ok({ value: knobbedSnapshot(section, entries), notes });
        }),
    );
  },
} satisfies SectionModule<"collaborators", typeof ENDPOINTS>;
