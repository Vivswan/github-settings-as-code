/**
 * The mock's permission gate: grading an endpoint's declared requirement (or a
 * bare resource) against the scenario's token permission mask, and the denial
 * responses - REST status+body and GraphQL errors[] - a failed grading answers
 * with. Pure functions over the declarations in src/sections; the pipeline
 * (routes.ts) and the core-path handlers (core-paths.ts) consume them.
 */

import type { SectionKey } from "../../../src/schema.js";
import {
  endpointKind,
  endpointPermission,
  type SectionPermission,
} from "../../../src/sections/contract.js";
import { SECTIONS, type TaggedEndpoint } from "../../../src/sections/registry.js";
import type { DenialStyle, MaskGrade, MaskKey, PermissionMask } from "../schema.js";
import type { GraphqlErrorReply, MockResponse } from "./support.js";

/** Look up a section module by key (for endpointPermission resolution). */
export const SECTION_BY_KEY = new Map<SectionKey, (typeof SECTIONS)[number]>(
  SECTIONS.map((section) => [section.key, section]),
);

/**
 * The effective permission requirement of an endpoint: its resolved
 * SectionPermission (or "none") paired with whether it reads or writes. The
 * gate composes both to grade the token mask.
 */
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

const GRADE_RANK: Record<MaskGrade, number> = { none: 0, read: 1, write: 2 };

/**
 * A token permission mask: resource -> grade (see PermissionMask in
 * ../schema.ts). In single-repo mode this is the scenario's
 * token_permissions; in multi-repo mode it is the target slug's per-repo mask
 * (so a denial can be scoped to one repository).
 */

/** The grade the token holds for a mask resource; unlisted resources are write. */
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

/**
 * The outcome of grading a requirement against the token mask: either allowed,
 * or denied and naming the resource that failed (logged as deniedBy). A "repo"
 * permission is satisfied by ANY listed resource meeting the grade; "org:
 * members" additionally requires org_members read. When repo access fails, the
 * denying resource is the FIRST listed repo resource (deterministic).
 */
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

/**
 * Grade a bare resource+level against a mask (for non-section paths like the
 * contents fetch, which has no SectionPermission). Returns the resource as
 * deniedBy on failure, matching the section-gate's shape.
 */
export function gradeResource(
  mask: PermissionMask,
  resource: MaskKey,
  level: "read" | "write",
): Grading {
  return grantsAtLeast(mask, resource, level)
    ? { allowed: true }
    : { allowed: false, deniedBy: resource };
}

/**
 * The effective permission mask for a request: the global scenario mask
 * overlaid by the per-slug mask, per resource (per-slug wins). In single-repo
 * mode `perSlug` is undefined and the global mask stands alone; in multi-repo
 * mode a repo that names only `issues` still inherits the global grades for
 * every other resource, so the global mask is never a silent no-op.
 */
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
 * The status and body a denied request answers with, by denial style and
 * read/write kind. fine_grained mirrors real fine-grained tokens (denied read
 * -> 404 Not Found, denied write -> 403 not accessible); the numeric styles
 * answer every denial uniformly. No message ever contains "rate limit", which
 * would be mistaken for throttling by the client's classifier.
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
 * The errors[] a denied GraphQL request answers with, by denial style and
 * read/write kind - the GraphQL flavor of denialResponse, delivered inside an
 * HTTP 200 like the real endpoint. fine_grained mirrors real fine-grained
 * tokens (a denied read conceals the resource as NOT_FOUND, a denied write is
 * FORBIDDEN); the numeric styles answer uniformly with their status's type.
 * No message ever contains "rate limit" (the client's classifier reads
 * RATE_LIMITED as throttling, which a denial must never be mistaken for).
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
