/**
 * The environments fuzz generator fragment, aggregated by test/e2e/generators.ts. It imports only
 * the test-tree leaf seams on purpose: the bundle entry is src/main.ts, so this file never reaches
 * lib/index.js.
 */

import { E2E_SECRET_ENV, type Json } from "../../../test/e2e/gen-support.js";
import { PROTECTION_RULE_APPS } from "../../../test/e2e/mock/state.js";
import type { Rng } from "../../../test/e2e/prng.js";

export function genEnvironments(rng: Rng): Json[] {
  // Each family's draws fork their own stream, so adding one never disturbs the main stream and
  // recorded seeds keep reproducing.
  const variablesRng = rng.fork("variables");
  const secretsRng = rng.fork("secrets");
  const policiesRng = rng.fork("branch-policies");
  const rulesRng = rng.fork("protection-rules");
  const pinnedRng = rng.fork("pinned");
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => {
    const env: Json = { name: `${rng.pick(["staging", "prod", "qa"])}-${i}` };
    if (rng.bool()) {
      env.wait_timer = rng.int(30);
    }
    if (rng.bool()) {
      env.prevent_self_review = rng.bool();
    }
    if (variablesRng.bool(0.35)) {
      // Mixed-case picks exercise the case-insensitive match; the suffix keeps names unique after it.
      // Over the empty live baseline an explicit `_undeclared` would change no outcome, so the wrapped
      // draw omits it (curated scenarios pin the keep-note and delete paths).
      const entries: Json[] = Array.from({ length: variablesRng.int(2) + 1 }, (_, j) => ({
        name: `${variablesRng.pick(["DEPLOY_REGION", "log_level", "Retries"])}_${j}`,
        value: variablesRng.pick(["eu-west-1", "debug", "3"]),
      }));
      env.variables = variablesRng.bool(0.25) ? { entries } : entries;
    }
    if (secretsRng.bool(0.3)) {
      // References come from the fixed pool so scenarioSecretEnv can wire the child env. Same-named
      // secrets across sibling environments are deliberately common: per-environment scope
      // resolution is exactly what that exercises.
      const names = Object.keys(E2E_SECRET_ENV);
      const count = secretsRng.int(names.length) + 1;
      const entries: Json[] = names.slice(0, count).map((name) => ({
        name,
        value: `$${name}`,
      }));
      env.secrets = secretsRng.bool(0.25) ? { entries } : entries;
    }
    if (policiesRng.bool(0.3)) {
      // The suffix keeps names unique (the natural key is the exact pattern string). The list is
      // ALWAYS paired with custom_branch_policies: true, so the oracle never sees the validation-error path.
      const entries: Json[] = Array.from({ length: policiesRng.int(2) + 1 }, (_, j) => {
        const entry: Json = { name: `${policiesRng.pick(["release/*", "hotfix/*", "v*"])}-${j}` };
        if (policiesRng.bool(0.4)) {
          entry.type = policiesRng.pick(["branch", "tag"]);
        }
        return entry;
      });
      env.deployment_branch_policies = policiesRng.bool(0.25) ? { entries } : entries;
      env.deployment_branch_policy = { protected_branches: false, custom_branch_policies: true };
    }
    if (rulesRng.bool(0.3)) {
      // Slugs come ONLY from PROTECTION_RULE_APPS (the mock's available-Apps listing serves the same
      // objects), so every declared rule resolves. The wrapped draw omits `_undeclared` for the same
      // reason as the variables above.
      const slugs = PROTECTION_RULE_APPS.map((app) => String(app.slug));
      const count = rulesRng.int(slugs.length) + 1;
      const entries: Json[] = slugs.slice(0, count).map((slug) => ({ app: slug }));
      env.deployment_protection_rules = rulesRng.bool(0.25) ? { entries } : entries;
    }
    if (pinnedRng.bool(0.25)) {
      // Gates the GraphQL pins read onto a subset of iterations; curated scenarios pin the interleaving and cap paths.
      //   pinned: true   -> at most 3 entries, so the count never approaches GitHub's cap
      //   pinned: false  -> a no-op unpin over the empty baseline: the read runs, no mutation
      env.pinned = pinnedRng.bool(0.7);
    }
    return env;
  });
}
