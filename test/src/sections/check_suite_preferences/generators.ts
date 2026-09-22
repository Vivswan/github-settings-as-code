/**
 * The check_suite_preferences fuzz generator fragment, aggregated by test/e2e/generators.ts.
 */

import type { Json } from "../../../e2e/gen-support.js";
import type { Rng } from "../../../e2e/prng.js";

// A prefix of this list, so the ids are positive and distinct by construction: schema.ts refuses 0, fractions, and a repeat.
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
