/**
 * The collaborators section's fuzz generator fragment: the settings generator
 * plus the pending-invitation live-state seeder, aggregated by
 * test/e2e/generators.ts. Imports the shared role vocabulary (roles.ts) and
 * only the test-tree leaf seams (gen-support.ts, prng.ts) - the src -> test
 * inversion is deliberate; the bundle entry is src/main.ts, so this file
 * never reaches lib/index.js.
 */

import { type EntriesForm, type Json, maybeWrapUndeclared } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";
import { DEFAULT_ROLE, roleForPermission } from "../roles.js";

export function genCollaborators(rng: Rng): EntriesForm {
  const used = new Set<string>();
  const out: Json[] = [];
  const count = rng.int(3) + 1;
  for (let i = 0; i < count; i++) {
    const username = `${rng.pick(["octocat", "hubot", "dev"])}-${i}`;
    if (used.has(username.toLowerCase())) {
      continue;
    }
    used.add(username.toLowerCase());
    out.push({ username, permission: rng.pick(["pull", "push", "maintain", "admin"]) });
  }
  return maybeWrapUndeclared(rng, out);
}

/** The undeclared pending-invitation invitee; no generated username collides with it. */
const UNDECLARED_INVITEE = "zz-undeclared-invitee";

/**
 * Pending-invitation live state for the declared collaborators: some
 * declared users get a pending invitation (matching the declared permission,
 * mismatched, or expired), and sometimes an undeclared invitee rides along.
 * Every relation converges under a fully-granted apply - matched invitations
 * are left alone, mismatches PATCHed, expired ones re-sent, the undeclared
 * one cancelled (or kept as a note) - so the fixpoint and convergence gates
 * hold without the oracle modeling a collaborators witness kind.
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
