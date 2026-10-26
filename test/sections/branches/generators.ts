/**
 * The branches fuzz generator fragment, aggregated by test/e2e/generators/settings.ts.
 */

import type { Json } from "../../e2e/generators/gen-support.js";
import type { Rng } from "../../e2e/generators/prng.js";
import {
  BYPASS_ACTOR_TEAMS,
  BYPASS_ACTOR_USERS,
  PROTECTION_RULE_APPS,
} from "../../e2e/mock/state.js";

/** The keys the classic PUT null-fills when omitted; one is drawn when every other draw left the protection empty. */
const PROTECTION_CORE_KEYS = [
  "required_status_checks",
  "enforce_admins",
  "required_pull_request_reviews",
  "restrictions",
] as const;

/** presenceLiveState seeds every one of these as a live environment, so the mock's silent drop of a name it lacks never turns a fully-granted apply into a read-back failure. */
export const FUZZ_DEPLOYMENT_ENVIRONMENTS = ["fuzz-deploy-a", "fuzz-deploy-b"] as const;

/**
 * Actors come from the mock's known rosters so a generated allowance always resolves; environment
 * names come from the pool presenceLiveState seeds as live environments, so the mutation's silent
 * drop never fires on a generated document.
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
 * A literal entry's protection: any subset of the core keys, since the handler null-fills the omitted
 * ones, never empty, with the signature toggle drawn from its own stream.
 */
function genLiteralProtection(rng: Rng, sigRng: Rng): Json {
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
    // Both spellings the PUT takes: bare names, or {context, app_id} items (-1 lets any App report).
    protection.required_status_checks = rng.bool(0.3)
      ? { strict: rng.bool(), checks: [{ context: "ci", app_id: -1 }, { context: "lint" }] }
      : { strict: rng.bool(), contexts: [] };
  }
  if (rng.bool(0.3)) {
    protection.restrictions = null;
  }
  if (Object.keys(protection).length === 0) {
    const key = rng.pick(PROTECTION_CORE_KEYS);
    protection[key] = key === "enforce_admins" ? true : null;
  }
  if (sigRng.bool(0.3)) {
    protection.required_signatures = sigRng.bool();
  }
  return protection;
}

/** A wildcard entry's protection: only keys with GraphQL twins, never empty. */
function genWildcardProtection(bprRng: Rng): Json {
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
  return wildcard;
}

export function genBranches(rng: Rng): Json[] {
  // Later families fork their own streams so recorded seeds keep reproducing. The GraphQL rule
  // surface is gated onto a MINORITY of entries so most iterations stay pure-REST and the
  // zero-GraphQL guarantee for existing users keeps getting exercised.
  const sigRng = rng.fork("required-signatures");
  const bprRng = rng.fork("bpr");
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const name = `${rng.pick(["main", "release", "dev"])}-${i}`;
    if (rng.bool(0.3)) {
      return { name, protection: null };
    }
    const protection = genLiteralProtection(rng, sigRng);
    // The first entry stays literal so every generated document reaches the protection read (the
    // fault target); the draw is consumed either way.
    if (bprRng.bool(0.25) && i > 0) {
      const wildcard = genWildcardProtection(bprRng);
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
