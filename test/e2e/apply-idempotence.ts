/**
 * Which sections are COMPARE-BEFORE-WRITE: a SECOND apply must issue ZERO
 * writes for them beyond alwaysRewrite endpoints. The rest write
 * unconditionally, so their proof is state STABILITY, not write silence.
 *
 * Every entry is verified against the section's apply-mode write decision in
 * src/sections/:
 * - labels (true): the update is skipped when name, color, description, and
 *   the extra keys all match the live label.
 * - autolinks (true): a live autolink whose declared fields subsetDiff clean
 *   is left alone; only a mismatch triggers the delete-and-recreate.
 * - workflows (true): enable/disable fires only when the live state differs
 *   from the declared one.
 * - collaborators (true): the PUT is skipped when the live role_name already
 *   equals the declared role, a pending invitation matching the declared
 *   permission (or carrying an unverifiable custom role) is left alone, and
 *   the invitation PATCH/cancel fire only on divergence.
 * - milestones (true): the PATCH is skipped when the declared fields
 *   subsetDiff clean against the live milestone.
 * - actions_variables (true): the PATCH is skipped when the live value (and
 *   any declared passthrough fields) already match the declaration.
 * - agents_variables (true): as actions_variables, over the Copilot agents
 *   variable store.
 * - deploy_keys (true): the delete-and-recreate fires only when the declared
 *   entry diverges from the live key (material compared as algorithm + blob,
 *   comments ignored; a declared read_only compared verbatim).
 * - secret_scanning_custom_patterns (true): the bulk POST carries only the
 *   missing patterns, each PATCH only the divergent declared fields, and the
 *   bulk DELETE only undeclared patterns under `undeclared: delete` - a
 *   converged repo produces none of the three.
 * - repository (false): every write is planned on drift except the Git LFS
 *   PUT/DELETE, which is alwaysRewrite by declaration (no read endpoint), so
 *   a second apply re-asserts it and the section stays false.
 * - rulesets (false): an existing ruleset is PUT unconditionally (the GET +
 *   diff runs only in check mode).
 * - branches (false): declared protection is PUT unconditionally (only the
 *   protection: null removal probes first).
 * - environments (false): every declared environment is PUT unconditionally.
 *   The nested `variables` reconciliation does compare before writing (it
 *   lists and diffs first, so a second apply issues no variable writes), but
 *   the unconditional PUT keeps the whole section false; the state-stability
 *   half of the proof covers the variables family, and the nested `secrets`
 *   PUTs are always-rewrite by contract (see ALWAYS_REWRITE_STATE_FAMILIES).
 * - actions (true): every endpoint group's PUT is planned only when its own
 *   GET diverges from the declared body.
 * - actions_secrets, dependabot_secrets, codespaces_secrets, agents_secrets
 *   (true): every write is gated on the listing except the sealed PUT, which
 *   recurs by declaration (alwaysRewrite: no value to compare against) and
 *   is exempt on that flag; the mock stores a digest, so state stays stable.
 * - pages (true): the site is PUT only when the declared fields diverge.
 * - code_scanning_default_setup, code_quality_setup (true): the PATCH is
 *   planned only when the declared keys diverge from the live setup.
 * - check_suite_preferences (false): no read endpoint exists to compare
 *   against, so the PATCH is alwaysRewrite by declaration.
 * - teams (false): team access is granted (PUT) unconditionally.
 * - interaction_limits (false): the base PUT is alwaysRewrite by declaration
 *   (it re-arms the self-expiring limit; the expiry cannot be read back); the
 *   cap PATCH and bypass writes are drift-gated, but the base PUT keeps it false.
 * - webhooks (false): a DECLARED config.secret rides the config PATCH on
 *   every apply run (GitHub echoes a live secret as "********", so there is
 *   nothing to compare against and re-sending is how rotations propagate);
 *   the events/active PATCH and the no-secret config PATCH do diff first,
 *   but one unconditional write path makes the section unconditional here.
 * - custom_properties (true): the ONE bulk PATCH carries only divergent
 *   properties and is skipped entirely when every declared value already
 *   matches the live one (and no undeclared unset is due).
 *
 * This table lives in the harness (like DENIAL_SEMANTICS): the engine has no
 * use for it, and both sides are guarded. A wrong `true` fails the first
 * apply_idempotent run that touches the section (the zero-write assertion,
 * which exempts alwaysRewrite endpoints).
 * A wrong `false` is caught corpus-wide by unwitnessedUnconditionalSections
 * (apply-idempotence-proof.ts, consulted by run.ts over the full corpus), which demands every
 * false-listed section BOTH appears in some apply_idempotent scenario's
 * first-apply writes AND is re-written by some second apply - so a section
 * that quietly becomes compare-before-write, or that loses its corpus
 * witness, fails there. The Record type gives compile-time completeness (a
 * missing or unknown key fails tsc).
 */

import type { SectionKey } from "../../src/schema.js";
import { allEndpoints } from "../../src/sections/registry.js";

export const COMPARE_BEFORE_WRITE: Record<SectionKey, boolean> = {
  repository: false,
  labels: true,
  rulesets: false,
  branches: false,
  environments: false,
  autolinks: true,
  actions: true,
  actions_secrets: true,
  dependabot_secrets: true,
  codespaces_secrets: true,
  agents_secrets: true,
  workflows: true,
  check_suite_preferences: false,
  pages: true,
  code_scanning_default_setup: true,
  code_quality_setup: true,
  collaborators: true,
  teams: false,
  milestones: true,
  interaction_limits: false,
  actions_variables: true,
  agents_variables: true,
  webhooks: false,
  custom_properties: true,
  deploy_keys: true,
  secret_scanning_custom_patterns: true,
};

/**
 * The ALWAYS-REWRITE half of the idempotence proof reads two declarations:
 *
 * - Which WRITES must recur on a second apply comes from the EndpointDecl
 *   `alwaysRewrite` flag (missingSecondApplyRewrites resolves each logged
 *   write to its endpoint): per ENDPOINT, since environments mixes both kinds.
 *
 * - Which MOCK STATE FAMILIES may move their updated_at between applies
 *   comes from this mapping: each flagged endpoint names its state family, or null
 *   when nothing in it moves (Git LFS stores nothing; check suite preferences carry no
 *   timestamp). The lockstep test pins the KEY SET against the flags.
 */
export const ALWAYS_REWRITE_ENDPOINT_FAMILIES: Readonly<Record<string, string | null>> = {
  "actions_secrets.put": "actions_secrets",
  "dependabot_secrets.put": "dependabot_secrets",
  "codespaces_secrets.put": "codespaces_secrets",
  "agents_secrets.put": "agents_secrets",
  "environments.putSecret": "environment_secrets",
  "interaction_limits.put": "interaction_limits",
  "repository.lfsPut": null,
  "repository.lfsRemove": null,
  "check_suite_preferences.update": null,
};

/** The snapshot exclusion set snapshotFamilies consumes, from the mapping. */
export const ALWAYS_REWRITE_STATE_FAMILIES: ReadonlySet<string> = new Set(
  Object.values(ALWAYS_REWRITE_ENDPOINT_FAMILIES).filter((family) => family !== null),
);

/**
 * The "section.role" keys of every endpoint declaring alwaysRewrite, derived
 * from the declarations. Exists for the lockstep test; the runtime consumers
 * read the flag per endpoint, never through this list.
 */
export function alwaysRewriteEndpointKeys(): string[] {
  return Object.entries(allEndpoints())
    .filter(([, endpoint]) => endpoint.alwaysRewrite)
    .map(([key]) => key)
    .sort();
}
