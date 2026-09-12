/** The mock's permission gate, pure over the src/sections declarations; routes.ts and core-paths.ts consume it. */

import type { SectionKey } from "../../../src/schema.js";
import { endpointKind } from "../../../src/sections/contract/endpoints.js";
import { endpointPermission } from "../../../src/sections/contract/module.js";
import type { SectionPermission } from "../../../src/sections/contract/permissions.js";
import { SECTIONS, type TaggedEndpoint } from "../../../src/sections/registry.js";
import {
  type DenialStyle,
  GRADE_RANK,
  type MaskGrade,
  type MaskKey,
  type PermissionMask,
} from "../schema.js";
import type { GraphqlErrorReply, MockResponse } from "./support.js";

export const SECTION_BY_KEY = new Map<SectionKey, (typeof SECTIONS)[number]>(
  SECTIONS.map((section) => [section.key, section]),
);

export interface Requirement {
  permission: SectionPermission | "none";
  kind: "read" | "write";
}

export function endpointRequirement(endpoint: TaggedEndpoint): Requirement {
  const section = SECTION_BY_KEY.get(endpoint.section);
  if (!section) {
    throw new Error(`BUG: no section module registered for key "${endpoint.section}"`);
  }
  return { permission: endpointPermission(section, endpoint), kind: endpointKind(endpoint) };
}

// --- Permission mask grading ---------------------------------------------

function maskGrade(mask: PermissionMask, resource: MaskKey): MaskGrade {
  return mask[resource] ?? "write";
}

export function grantsAtLeast(
  mask: PermissionMask,
  resource: MaskKey,
  needed: "read" | "write",
): boolean {
  return GRADE_RANK[maskGrade(mask, resource)] >= GRADE_RANK[needed];
}

export type Grading = { allowed: true } | { allowed: false; deniedBy: MaskKey };

export function gradeRequirement(mask: PermissionMask, req: Requirement): Grading {
  if (req.permission === "none") {
    return { allowed: true };
  }
  const permission = req.permission;
  const repoOk = permission.repo.some((resource) => grantsAtLeast(mask, resource, req.kind));
  if (!repoOk) {
    return { allowed: false, deniedBy: permission.repo[0] };
  }
  if (permission.org === "members" && !grantsAtLeast(mask, "org_members", "read")) {
    return { allowed: false, deniedBy: "org_members" };
  }
  return { allowed: true };
}

/** For non-section paths (the contents fetch) that have no SectionPermission; deniedBy matches the section gate's shape. */
export function gradeResource(
  mask: PermissionMask,
  resource: MaskKey,
  level: "read" | "write",
): Grading {
  return grantsAtLeast(mask, resource, level)
    ? { allowed: true }
    : { allowed: false, deniedBy: resource };
}

export function effectiveMask(
  global: PermissionMask,
  perSlug: PermissionMask | undefined,
): PermissionMask {
  if (!perSlug) {
    return global;
  }
  return { ...global, ...perSlug };
}

// --- Denial responses -----------------------------------------------------

/**
 * fine_grained mirrors real fine-grained tokens (denied read -> 404 Not Found, denied write -> 403 not accessible); the
 * numeric styles answer every denial uniformly. No message ever says "rate limit", which the client's classifier would
 * read as throttling.
 */
export function denialResponse(style: DenialStyle, kind: "read" | "write"): MockResponse {
  if (style === 403) {
    return { status: 403, body: { message: "Resource not accessible by personal access token" } };
  }
  if (style === 404) {
    return { status: 404, body: { message: "Not Found" } };
  }
  return kind === "read"
    ? { status: 404, body: { message: "Not Found" } }
    : { status: 403, body: { message: "Resource not accessible by personal access token" } };
}

/**
 * The GraphQL flavor of denialResponse, inside an HTTP 200 like the real endpoint: fine_grained conceals a denied read
 * as NOT_FOUND and answers a denied write FORBIDDEN. Never RATE_LIMITED, which the client's classifier reads as throttling.
 */
export function graphqlDenialErrors(
  style: DenialStyle,
  kind: "read" | "write",
): GraphqlErrorReply[] {
  const forbidden: GraphqlErrorReply = {
    type: "FORBIDDEN",
    message: "Resource not accessible by personal access token",
  };
  const notFound: GraphqlErrorReply = {
    type: "NOT_FOUND",
    message: "Could not resolve to a Repository with the given name",
  };
  if (style === 403) {
    return [forbidden];
  }
  if (style === 404) {
    return [notFound];
  }
  return kind === "read" ? [notFound] : [forbidden];
}
