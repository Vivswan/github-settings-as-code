/**
 * The collaborators fuzz generator fragment and the pending-invitation live-state seeder. It imports
 * test-tree seams on purpose: the bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import {
  type EntriesForm,
  generatorFromSlice,
  type Json,
  maybeWrapUndeclared,
  uniqueBy,
} from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";
import { DEFAULT_ROLE, roleForPermission } from "../shared/roles.js";
import { CollaboratorConfig } from "./schema.js";

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
      invitation.permissions = rng.pick(
        ["read", "write", "maintain", "triage", "admin"].filter((role) => role !== wantRole),
      );
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
