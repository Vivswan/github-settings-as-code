/**
 * The workflows fuzz generator fragment, aggregated by test/e2e/generators/settings.ts.
 */

import type { Json } from "../../e2e/generators/gen-support.js";
import type { Rng } from "../../e2e/generators/prng.js";

export function genWorkflows(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    path: `.github/workflows/${rng.pick(["ci", "release", "lint"])}-${i}.yml`,
    state: rng.pick(["active", "disabled"] as const),
  }));
}
