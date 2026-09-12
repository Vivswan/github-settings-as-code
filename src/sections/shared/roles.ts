/** The one normalizer shared by two sections: collaborators and teams. */

/** Both handlers default an entry without `permission` to it, so the two sections cannot disagree; "push" is GitHub's own write default. */
export const DEFAULT_ROLE = "push";

/**
 * GET reports role_name in the read vocabulary (read/write) while the PUT takes pull/push, so check mode
 * compares like with like. Custom org role names pass through.
 */
export function roleForPermission(permission: string): string {
  const roles: Record<string, string> = { push: "write", pull: "read" };
  return roles[permission] ?? permission;
}

/**
 * The GET reports this enum and the PATCH accepts nothing else, so a declared custom org role can never be
 * verified on (or set on) a pending invitation; the PUT applies it once accepted. The e2e mock's stored
 * invitations must stay inside it; a lockstep test pins it to the trimmed OpenAPI spec.
 */
export const INVITATION_ROLES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "maintain",
  "triage",
  "admin",
]);
