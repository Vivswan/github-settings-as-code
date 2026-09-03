/**
 * The collaborators fuzz fragment: the entry generator walks the CollaboratorConfig slice (a new
 * schema field is fuzzed without an edit here) with the unique-login invariant on top, and the
 * pending-invitation live-state seeder beside it. Imports only the test-tree seams, never the bundle.
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
  // The section's own rule: one entry per login, case-insensitively.
  return maybeWrapUndeclared(
    rng,
    uniqueBy(collaborators, ["username"], (login) => login.toLowerCase()),
  );
}

/** The undeclared pending-invitation invitee; no generated username collides with it. */
const UNDECLARED_INVITEE = "zz-undeclared-invitee";

/**
 * Pending-invitation live state for the declared collaborators: some get a pending invitation
 * (matching, mismatched, or expired) and sometimes an undeclared invitee rides along. Every relation
 * converges under a fully-granted apply, so the fixpoint gates hold without a collaborators witness kind.
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
