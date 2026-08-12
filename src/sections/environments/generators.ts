/**
 * The environments section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, mock/state.ts, prng.ts) - the src -> test inversion is
 * deliberate; the bundle entry is src/main.ts, so this file never reaches
 * lib/index.js.
 */

import { E2E_SECRET_ENV, type Json } from "../../../test/e2e/gen-support.js";
import { PROTECTION_RULE_APPS } from "../../../test/e2e/mock/state.js";
import type { Rng } from "../../../test/e2e/prng.js";

export function genEnvironments(rng: Rng): Json[] {
  // The variables draws are NEW, so they live on a forked stream: the main
  // stream stays stable and recorded seeds keep reproducing.
  const variablesRng = rng.fork("variables");
  // The nested secrets draws are NEWER still, so they fork off their own
  // stream for the same reason.
  const secretsRng = rng.fork("secrets");
  // And the branch-policy pattern draws are the newest, on their own fork.
  const policiesRng = rng.fork("branch-policies");
  // Protection-rule draws, newer again, fork the same way.
  const rulesRng = rng.fork("protection-rules");
  // Pin draws are the newest, again on their own forked stream.
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
      // Names are unique per environment by the suffix even after the
      // case-insensitive uppercase match, and mixed-case picks exercise it.
      // The empty live baseline means an explicit `undeclared` policy would
      // change no outcome, so the wrapped draw omits it (the keep-note and
      // delete paths are pinned by curated scenarios); the bare `{entries}`
      // wrapper still exercises the nested knob's parsing and schema surface.
      const entries: Json[] = Array.from({ length: variablesRng.int(2) + 1 }, (_, j) => ({
        name: `${variablesRng.pick(["DEPLOY_REGION", "log_level", "Retries"])}_${j}`,
        value: variablesRng.pick(["eu-west-1", "debug", "3"]),
      }));
      env.variables = variablesRng.bool(0.25) ? { entries } : entries;
    }
    if (secretsRng.bool(0.3)) {
      // References come from the fixed pool, like every secret family, so
      // scenarioSecretEnv can wire the child env. Same-named secrets across
      // sibling environments are deliberately common here (the pool is
      // small): per-environment scope resolution is exactly what that
      // exercises.
      const names = Object.keys(E2E_SECRET_ENV);
      const count = secretsRng.int(names.length) + 1;
      const entries: Json[] = names.slice(0, count).map((name) => ({
        name,
        value: `$${name}`,
      }));
      env.secrets = secretsRng.bool(0.25) ? { entries } : entries;
    }
    if (policiesRng.bool(0.3)) {
      // The index suffix keeps names unique (the natural key is the exact
      // pattern string). The generator ALWAYS pairs the list with the
      // singular flag object set to custom_branch_policies: true, so the
      // oracle never sees the section's validation-error path.
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
      // App slugs come ONLY from the shared PROTECTION_RULE_APPS fixture (the
      // mock's available-Apps listing serves the same objects), so a declared
      // rule can always resolve and enable. The slice keeps slugs unique per
      // environment. The empty live baseline means an explicit `undeclared`
      // policy would change no outcome, so the wrapped draw omits it (the
      // keep-note and disable paths are pinned by curated scenarios).
      const slugs = PROTECTION_RULE_APPS.map((app) => String(app.slug));
      const count = rulesRng.int(slugs.length) + 1;
      const entries: Json[] = slugs.slice(0, count).map((slug) => ({ app: slug }));
      env.deployment_protection_rules = rulesRng.bool(0.25) ? { entries } : entries;
    }
    if (pinnedRng.bool(0.25)) {
      // A small subset declares a pin state, gating the GraphQL pins read
      // onto those iterations. The entry count stays tiny (<= 3), so the
      // declared pinned: true count can never approach GitHub's 10 cap;
      // pinned: false over the empty pins baseline is a no-op unpin, which
      // exercises the read without a mutation. The interleaving and cap
      // paths are pinned by curated scenarios.
      env.pinned = pinnedRng.bool(0.7);
    }
    return env;
  });
}
