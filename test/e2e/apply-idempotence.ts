/**
 * Which sections are COMPARE-BEFORE-WRITE: their apply path reads the live
 * resource and skips the write when it already matches the declaration, so a
 * SECOND apply over just-applied state must issue ZERO writes for them. The
 * rest write unconditionally in apply mode (one PUT/PATCH is their cheapest
 * way to converge), so a second apply legitimately writes again - for those,
 * the apply-idempotence proof is state STABILITY, not write silence.
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
 *   equals the declared role.
 * - milestones (true): the PATCH is skipped when the declared fields
 *   subsetDiff clean against the live milestone.
 * - actions_variables (true): the PATCH is skipped when the live value (and
 *   any declared passthrough fields) already match the declaration.
 * - repository (false): the base PATCH, the topics PUT, and each feature
 *   toggle's PUT/DELETE run unconditionally (enable_git_lfs necessarily so:
 *   no read endpoint exists to compare against).
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
 * - actions (false): every declared endpoint group is PUT unconditionally.
 * - actions_secrets, dependabot_secrets, codespaces_secrets (false): every
 *   declared secret is re-sealed and re-PUT on every apply BY DESIGN -
 *   GitHub cannot return a value to compare against, and the unconditional
 *   rewrite is what makes a rotated source value propagate. State stability
 *   holds because the mock stores a deterministic digest of the unsealed
 *   value, not the (per-seal random) ciphertext.
 * - pages (false): an existing site is PUT unconditionally.
 * - code_scanning_default_setup (false): the PATCH runs unconditionally.
 * - teams (false): team access is granted (PUT) unconditionally.
 * - interaction_limits (false): the PUT re-arms the self-expiring limit
 *   unconditionally on every apply - the re-arm IS the desired behavior.
 * - webhooks (false): a DECLARED config.secret rides the config PATCH on
 *   every apply run (GitHub echoes a live secret as "********", so there is
 *   nothing to compare against and re-sending is how rotations propagate);
 *   the events/active PATCH and the no-secret config PATCH do diff first,
 *   but one unconditional write path makes the section unconditional here.
 *
 * This table lives in the harness (like DENIAL_SEMANTICS): the engine has no
 * use for it, and the apply-idempotence re-run is its contradiction path - a
 * wrong `true` fails the first idempotent run that touches the section, and a
 * wrong `false` weakens the proof without breaking it. The Record type gives
 * compile-time completeness (a missing or unknown key fails tsc).
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
  actions: false,
  actions_secrets: false,
  dependabot_secrets: false,
  codespaces_secrets: false,
  workflows: true,
  pages: false,
  code_scanning_default_setup: false,
  collaborators: true,
  teams: false,
  milestones: true,
  interaction_limits: false,
  actions_variables: true,
  webhooks: false,
};

/**
 * The ALWAYS-REWRITE half of the idempotence proof reads two declarations:
 *
 * - Which WRITES must recur on a second apply comes from the EndpointDecl
 *   `alwaysRewrite` flag the sealed secret PUTs declare (see
 *   missingSecondApplyRewrites in runner.ts, which resolves each logged PUT
 *   to its endpoint). The property is per ENDPOINT, not per section, because
 *   environments carries a passthrough PUT and always-rewrite secret PUTs
 *   side by side.
 *
 * - Which MOCK STATE FAMILIES may move their updated_at between applies
 *   comes from this mapping: every flagged endpoint (by its "section.role"
 *   key) names the state family its writes land in. State families are the
 *   mock's own storage layout, so they cannot be derived from the
 *   declarations - but deriving the FAMILY SET from this mapping and pinning
 *   the KEY SET against the flags (the lockstep test in runner.test.ts)
 *   means a NEW flagged endpoint fails the suite until it declares its
 *   family here, even inside a section that already carries one.
 */
export const ALWAYS_REWRITE_ENDPOINT_FAMILIES: Readonly<Record<string, string>> = {
  "actions_secrets.put": "actions_secrets",
  "dependabot_secrets.put": "dependabot_secrets",
  "codespaces_secrets.put": "codespaces_secrets",
  "environments.putSecret": "environment_secrets",
};

/** The snapshot exclusion set snapshotFamilies consumes, from the mapping. */
export const ALWAYS_REWRITE_STATE_FAMILIES: ReadonlySet<string> = new Set(
  Object.values(ALWAYS_REWRITE_ENDPOINT_FAMILIES),
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
