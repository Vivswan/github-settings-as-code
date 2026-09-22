/** The permission vocabulary shared by collaborators and teams. */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { type SectionFailure, sectionFailure } from "../contract/errors.js";
import type { SectionMeta } from "../contract/module.js";
import { leftOutOfSnapshot } from "./snapshot-helpers.js";

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

/** The grant PUT's own vocabulary; anything else it accepts is a custom org role, named exactly as the org spelled it. */
const STANDARD_PERMISSIONS = ["pull", "triage", "push", "maintain", "admin"] as const;

/**
 * A permission the file alone shows GitHub will not take is refused at parse; a custom org role name passes.
 * The two wrong spellings hide until apply: "write" on an existing Write collaborator converges with zero drift
 * (the live role_name IS "write") while the same entry on a new one PUTs {"permission":"write"} and 422s.
 *
 *   read, write (any case)            -> the vocabulary GET reports a role in; the grant takes pull, push
 *   Push, ADMIN (a mis-cased standard) -> the lowercase form
 *   "", " push", "push\n" (block scalar) -> nothing to grant, or whitespace GitHub would not match
 *
 * One regex, so the published schema carries the same rule as a `pattern` (a pattern has no flags, hence the
 * case classes): an exact standard permission, or one line with no whitespace at either end that folds to none
 * of the seven words.
 */
const REFUSED_FOLDED = [...STANDARD_PERMISSIONS, ...PERMISSION_FOR_ROLE.keys()];
const caseless = (word: string) => [...word].map((c) => `[${c.toUpperCase()}${c}]`).join("");
const PERMISSION_PATTERN = new RegExp(
  `^(?:${STANDARD_PERMISSIONS.join("|")}|(?!(?:${REFUSED_FOLDED.map(caseless).join("|")})$)\\S(?:.*\\S)?)$`,
);

/** Every suggested fix is one the pattern accepts, so a reader never chases a second refusal. */
function permissionError(declared: string): string {
  const options = `${STANDARD_PERMISSIONS.map((p) => `"${p}"`).join(", ")}, or a custom org role name`;
  const shown = JSON.stringify(declared);
  const trimmed = declared.trim();
  if (trimmed === "") {
    const what = declared === "" ? "an empty permission" : `${shown} (whitespace only)`;
    return `${what} grants nothing; declare ${options}, or omit the key for the default "${DEFAULT_ROLE}"`;
  }
  const folded = trimmed.toLowerCase();
  const reported = PERMISSION_FOR_ROLE.get(folded);
  const standard = (STANDARD_PERMISSIONS as readonly string[]).includes(folded);
  const fix = reported ?? (standard ? folded : trimmed);
  const shownFix = JSON.stringify(fix);
  if (!PERMISSION_PATTERN.test(fix)) {
    return `${shown} spans several lines; a permission is one line: ${options}`;
  }
  if (trimmed !== declared) {
    return `${shown} carries whitespace at an end (a YAML block scalar ends in a newline); declare ${shownFix}`;
  }
  if (reported !== undefined) {
    return `${shown} is the vocabulary GitHub reports a role in (role_name), not one a grant accepts; declare ${shownFix} (${options})`;
  }
  return `${shown} is not a permission GitHub accepts; the standard permissions are lowercase: declare ${shownFix}`;
}

export const PermissionSchema = z.string().regex(PERMISSION_PATTERN, {
  error: (issue: { input: unknown }) => permissionError(String(issue.input)),
});

/**
 * The GET reports this enum and the PATCH accepts nothing else, so a declared custom org role can never be
 * verified on (or set on) a pending invitation; the PUT applies it once accepted. The e2e mock's stored
 * invitations must stay inside it; a lockstep test pins it to GitHub's OpenAPI descriptor.
 */
export const INVITATION_ROLES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "maintain",
  "triage",
  "admin",
]);

/**
 * The permission a live role reads back as, for a snapshot. A role no declaration plans as ("push" in a
 * settings file means the "write" role) has no entry: where the section's default policy deletes what
 * the file omits, dropping the entry would plan a removal, so it is the snapshot's failure; elsewhere
 * the entry is left out with a note and undefined comes back.
 */
export function readBackPermission(
  section: SectionMeta,
  label: string,
  role: string,
  notes: string[],
): Result<string | undefined, SectionFailure> {
  const permission = permissionForRole(role);
  if (permission !== undefined) {
    return ok(permission);
  }
  const reason = `the live role "${role}" has no declaration that plans as itself ("${role}" in a settings file means the "${roleForPermission(role)}" role)`;
  if (section.undeclaredDefault === "delete") {
    return err(sectionFailure("live-shape", `${label}: ${reason}, so it cannot be read back`));
  }
  notes.push(leftOutOfSnapshot(label, reason));
  return ok(undefined);
}
