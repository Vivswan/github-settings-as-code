/** The one normalizer shared by two sections: collaborators and teams. */

/** Both handlers default an entry without `permission` to it, so the two sections cannot disagree; "push" is GitHub's own write default. */
export const DEFAULT_ROLE = "push";

/**
 * GET reports role_name in the read vocabulary (read/write) while the PUT takes pull/push, so check mode
 * compares like with like. Custom org role names pass through.
 */
export function roleForPermission(permission: string): string {
  return ROLE_FOR_PERMISSION.get(permission) ?? permission;
}

/**
 * The inverse: the declared permission a GET-vocabulary role reads back as (write -> push,
 * read -> pull, custom roles verbatim), for a snapshot. Undefined when the role is not one a
 * declaration could have produced, so a caller never emits a permission GitHub would map elsewhere.
 */
export function permissionForRole(role: string): string | undefined {
  const permission = PERMISSION_FOR_ROLE.get(role) ?? role;
  return roleForPermission(permission) === role ? permission : undefined;
}

// Maps, not records: a declared permission named like a prototype member ("constructor") must
// pass through, not resolve to Object.prototype's.
const ROLE_FOR_PERMISSION: ReadonlyMap<string, string> = new Map([
  ["push", "write"],
  ["pull", "read"],
]);
const PERMISSION_FOR_ROLE: ReadonlyMap<string, string> = new Map(
  [...ROLE_FOR_PERMISSION].map(([permission, role]) => [role, permission]),
);

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
