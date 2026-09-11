/**
 * The check_suite_preferences section's fuzz generator fragment, aggregated
 * by test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

/** GitHub App ids for auto_trigger_checks entries; count <= pool keeps them unique. */
const AUTO_TRIGGER_APP_IDS = [15368, 29310, 62410] as const;

export function genCheckSuitePreferences(rng: Rng): Json {
  return {
    auto_trigger_checks: Array.from(
      { length: rng.int(AUTO_TRIGGER_APP_IDS.length) + 1 },
      (_, i) => ({
        app_id: AUTO_TRIGGER_APP_IDS[i] as number,
        setting: rng.bool(),
      }),
    ),
  };
}
