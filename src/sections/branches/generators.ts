/**
 * The branches section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, mock/state.ts, prng.ts) - the src -> test inversion is
 * deliberate; the bundle entry is src/main.ts, so this file never reaches
 * lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import {
  BYPASS_ACTOR_TEAMS,
  BYPASS_ACTOR_USERS,
  PROTECTION_RULE_APPS,
} from "../../../test/e2e/mock/state.js";
import type { Rng } from "../../../test/e2e/prng.js";

/** The four core branch-protection keys the classic PUT requires. */
const PROTECTION_CORE_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

export function genBranches(rng: Rng): Json[] {
  // The required_signatures draws are NEW, so they live on a forked stream:
  // the main stream stays stable and recorded seeds keep reproducing.
  const sigRng = rng.fork("required-signatures");
  // The wildcard/bypassers/deployments draws are NEWER still - the GraphQL
  // rule surface - forked for the same stability reason, and gated onto a
  // MINORITY of entries so most iterations stay pure-REST (the
  // zero-GraphQL-for-existing-users guarantee keeps getting exercised).
  const bprRng = rng.fork("bpr");
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const name = `${rng.pick(["main", "release", "dev"])}-${i}`;
    if (rng.bool(0.3)) {
      return { name, protection: null };
    }
    // A random subset of the four core protection keys, with realistic values;
    // the handler null-fills the omitted ones, so any subset is valid input.
    const protection: Json = {};
    if (rng.bool(0.6)) {
      protection.required_pull_request_reviews = {
        required_approving_review_count: rng.int(3) + 1,
      };
    }
    if (rng.bool(0.5)) {
      protection.enforce_admins = rng.bool();
    }
    if (rng.bool(0.4)) {
      protection.required_status_checks = { strict: rng.bool(), contexts: [] };
    }
    if (rng.bool(0.3)) {
      protection.restrictions = null;
    }
    // Guarantee at least one core key so the payload is not empty.
    if (Object.keys(protection).length === 0) {
      const key = rng.pick(PROTECTION_CORE_KEYS);
      protection[key] = key === "enforce_admins" ? true : null;
    }
    if (sigRng.bool(0.3)) {
      protection.required_signatures = sigRng.bool();
    }
    // The first entry stays literal so every generated document reaches the
    // protection read (the fault target); the draw is consumed either way.
    if (bprRng.bool(0.25) && i > 0) {
      // A WILDCARD entry replaces the literal one: only translated keys, so
      // the whole entry reconciles through the GraphQL rule mutations.
      const wildcard: Json = {};
      if (bprRng.bool(0.6)) {
        wildcard.enforce_admins = bprRng.bool();
      }
      if (bprRng.bool(0.4)) {
        wildcard.required_status_checks = bprRng.bool(0.3)
          ? null
          : { strict: bprRng.bool(), contexts: [] };
      }
      if (bprRng.bool(0.4)) {
        wildcard.required_pull_request_reviews = {
          required_approving_review_count: bprRng.int(3) + 1,
        };
      }
      if (Object.keys(wildcard).length === 0) {
        wildcard.required_linear_history = true;
      }
      addRoutedGraphqlKeys(bprRng, wildcard);
      return {
        name: `${rng.pick(["main", "release", "dev"])}-${i}/*`,
        protection: bprRng.bool(0.15) ? null : wildcard,
      };
    }
    addRoutedGraphqlKeys(bprRng, protection);
    return { name, protection };
  });
}

/**
 * The minority draws for the two GraphQL-routed protection keys, shared by
 * literal and wildcard entries. Actors come from the mock's known rosters so
 * a generated allowance always resolves; deployment environment names come
 * from the fixed pool presenceLiveState seeds as live environments, so the
 * mutation's silent drop never fires on a generated document.
 */
function addRoutedGraphqlKeys(bprRng: Rng, protection: Json): void {
  if (bprRng.bool(0.25)) {
    const pool = [
      ...BYPASS_ACTOR_USERS,
      ...BYPASS_ACTOR_TEAMS,
      ...PROTECTION_RULE_APPS.map((app) => `app/${String(app.slug)}`),
    ];
    const count = bprRng.int(3);
    const picked = new Set<string>();
    for (let i = 0; i < count; i++) {
      picked.add(bprRng.pick(pool));
    }
    protection.force_push_bypassers = [...picked];
  }
  if (bprRng.bool(0.2)) {
    protection.required_deployments = bprRng.bool(0.3)
      ? null
      : { environments: [bprRng.pick(FUZZ_DEPLOYMENT_ENVIRONMENTS)] };
  }
}

/**
 * The deployment environments a generated required_deployments key may name.
 * presenceLiveState seeds every one of them as a live environment, so the
 * verified silent-drop behavior (the mock keeps only EXISTING names) never
 * turns a fully-granted apply into a read-back failure.
 */
export const FUZZ_DEPLOYMENT_ENVIRONMENTS = ["fuzz-deploy-a", "fuzz-deploy-b"] as const;
