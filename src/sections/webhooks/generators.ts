/**
 * The webhooks section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import {
  E2E_SECRET_ENV,
  type EntriesForm,
  type Json,
  maybeWrapUndeclared,
} from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

/** The whole-value references the webhook generator draws from. */
const E2E_SECRET_REFS = Object.keys(E2E_SECRET_ENV).map((name) => `$${name}`);

export function genWebhooks(rng: Rng): EntriesForm {
  const count = rng.int(2) + 1;
  const entries: Json[] = Array.from({ length: count }, (_, i) => {
    const config: Json = {
      url: `https://hooks.example.com/${rng.pick(["ci", "deploy", "notify"])}-${i}`,
    };
    if (rng.bool(0.6)) {
      config.content_type = rng.pick(["json", "form"]);
    }
    // Both spellings on purpose: GitHub stores insecure_ssl as a string, so
    // a declared number exercises the compare-side normalization.
    if (rng.bool(0.4)) {
      config.insecure_ssl = rng.pick(["0", "1", 0, 1] as const);
    }
    if (rng.bool(0.4)) {
      config.secret = rng.pick(E2E_SECRET_REFS);
    }
    const hook: Json = { config };
    if (rng.bool(0.6)) {
      hook.events = [
        ...new Set(
          Array.from({ length: rng.int(2) + 1 }, () =>
            rng.pick(["push", "pull_request", "issues", "release"]),
          ),
        ),
      ];
    }
    if (rng.bool(0.5)) {
      hook.active = rng.bool();
    }
    return hook;
  });
  return maybeWrapUndeclared(rng, entries);
}
