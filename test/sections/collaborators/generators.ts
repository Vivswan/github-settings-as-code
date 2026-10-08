/**
 * The collaborators fuzz generator fragment and the pending-invitation live-state seeder.
 */

import { CollaboratorConfig } from "../../../src/sections/collaborators/schema.js";
import { DEFAULT_ROLE, roleForPermission } from "../../../src/sections/shared/roles.js";
import { INVITATION_ROLES } from "../../../src/sections/shared/spec-roles.js";
import {
  type EntriesForm,
  generatorFromSlice,
  type Json,
  maybeWrapUndeclared,
  uniqueBy,
} from "../../e2e/generators/gen-support.js";
import type { Rng } from "../../e2e/generators/prng.js";

const genCollaborator = generatorFromSlice(CollaboratorConfig, {
  fields: {
    username: (rng) => rng.pick(["octocat", "hubot", "dev"]),
    permission: (rng) => rng.pick(["pull", "push", "maintain", "admin"]),
  },
  present: { permission: 0.8 },
});

export function genCollaborators(rng: Rng): EntriesForm {
  const collaborators = Array.from({ length: rng.int(3) + 1 }, () => genCollaborator(rng));
  return maybeWrapUndeclared(
    rng,
    uniqueBy(collaborators, ["username"], (login) => login.toLowerCase()),
  );
}

/** The undeclared pending-invitation invitee; no generated username collides with it. */
const UNDECLARED_INVITEE = "zz-undeclared-invitee";

/**
 * Every relation seeded here (matching, mismatched, expired, or an undeclared invitee) converges
 * under a fully-granted apply, so the fixpoint gates hold without a collaborators witness kind.
 */
export function genInvitationsState(rng: Rng, declared: Json[]): Json[] {
  const out: Json[] = [];
  for (const entry of declared) {
    if (!rng.bool(0.5)) {
      continue;
    }
    const wantRole = roleForPermission(String(entry.permission ?? DEFAULT_ROLE));
    const kind = rng.pick(["matching", "mismatched", "expired"] as const);
    const invitation: Json = { invitee: { login: entry.username }, permissions: wantRole };
    if (kind === "mismatched") {
      invitation.permissions = rng.pick([...INVITATION_ROLES].filter((role) => role !== wantRole));
    } else if (kind === "expired") {
      invitation.expired = true;
    }
    out.push(invitation);
  }
  if (rng.bool(0.3)) {
    out.push({ invitee: { login: UNDECLARED_INVITEE }, permissions: "write" });
  }
  return out;
}
