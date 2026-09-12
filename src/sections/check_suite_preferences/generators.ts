/**
 * The check_suite_preferences fuzz generator fragment, aggregated by test/e2e/generators.ts. It
 * imports only the test-tree leaf seams on purpose: the bundle entry is src/main.ts, so this file
 * never reaches lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

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
