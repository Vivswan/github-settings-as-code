/**
 * The one no-op behind `ownerSensitivity: "org"` (contract/module.ts): teams and custom properties exist
 * only under an organization owner, so both sections probe the owner first and stop with a note on a
 * personal account.
 */

import type { EndpointDecl } from "../contract/endpoints.js";
import type { SectionMeta } from "../contract/module.js";

/**
 * GET /orgs/{org} is public, so no token permission; its 404 is the personal-account signal. A section whose
 * other reads can never be denied marks it the primary read (`primaryRead: { notFound: "absent" }`).
 */
export const ORG_PROBE = {
  route: "GET /orgs/{org}",
  statuses: { 200: "the organization", 404: "not an organization (a personal account)" },
  permission: "none",
} as const satisfies EndpointDecl;

/**
 * Undefined under an organization owner. On a personal account (the probe answered "missing"), the note
 * the section emits instead of planning or snapshotting; a plan's says how to silence it, since the
 * section is declared in the file.
 */
export function personalAccountNote(
  section: SectionMeta,
  owner: string,
  probe: { data: unknown } | { missing: true },
  phase: "plan" | "snapshot",
): string | undefined {
  if (!("missing" in probe)) {
    return undefined;
  }
  const note = `${section.key}: owner "${owner}" is a personal account, not an organization, so this section does not apply`;
  return phase === "plan"
    ? `${note}; section skipped - remove the ${section.key} section from the settings file to silence this note`
    : note;
}
