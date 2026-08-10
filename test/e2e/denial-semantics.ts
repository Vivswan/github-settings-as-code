/**
 * Per-section denial semantics for the e2e harness. Under a fine-grained
 * token, a denied resource answers 404 on reads and 403 on writes. What that
 * 404 MEANS to a section depends on how the section's primary read is issued:
 *
 * - "denied": the primary read goes through the throwFor path, so a 404 is
 *   classified as PermissionDenied and the section stops. Preflight (a full
 *   read pass in apply mode) catches this before any write is attempted.
 * - "absent": the primary reads are probeAbsent with 404 tolerated, so a
 *   denied read looks like "the resource does not exist" and the section
 *   proceeds; the denial only surfaces later, when the first write returns 403.
 *
 * This table lives in the harness, not in SectionModule: the engine has no
 * use for it, and the fuzz loop is its contradiction path - a wrong entry
 * fails every fine-grained iteration that touches that section. The Record
 * type gives compile-time completeness (a missing or unknown key fails tsc).
 */

import type { SectionKey } from "../../src/schema.js";

export type DenialSemantics = "denied" | "absent";

export const DENIAL_SEMANTICS: Record<SectionKey, DenialSemantics> = {
  repository: "denied",
  labels: "denied",
  rulesets: "denied",
  branches: "absent",
  environments: "absent",
  autolinks: "denied",
  actions: "denied",
  actions_secrets: "denied",
  dependabot_secrets: "denied",
  codespaces_secrets: "denied",
  agents_secrets: "denied",
  workflows: "denied",
  pages: "absent",
  code_scanning_default_setup: "denied",
  collaborators: "denied",
  teams: "absent",
  milestones: "denied",
  interaction_limits: "denied",
  actions_variables: "denied",
  agents_variables: "denied",
  webhooks: "denied",
  // The primary read (GET .../properties/values) is Metadata-gated only, so a
  // fine-grained denial never touches it: like the "absent" sections, the
  // denial surfaces on the first write (the bulk PATCH answers 403). The
  // 403-style caveat the "absent" model carries does not even apply to the
  // reads here (they are permission-"none" and cannot be denied at all), so
  // the generator strips the section under a mask that denies
  // custom_properties outright (see suppressMaskedCustomProperties) and a
  // curated scenario pins the write-denied path.
  custom_properties: "absent",
  deploy_keys: "denied",
  secret_scanning_custom_patterns: "denied",
};
