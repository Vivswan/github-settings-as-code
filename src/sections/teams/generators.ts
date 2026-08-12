/**
 * The teams section's fuzz generator fragment, aggregated by
 * test/e2e/generators.ts. Imports only the test-tree leaf seams
 * (gen-support.ts, prng.ts) - the src -> test inversion is deliberate; the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import type { Json } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";

export function genTeams(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    name: `${rng.pick(["core", "reviewers", "ops"])}-${i}`,
    permission: rng.pick(["pull", "push", "maintain", "admin"]),
  }));
}
