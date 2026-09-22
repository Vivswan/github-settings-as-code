/**
 * The workflows fuzz generator fragment, aggregated by test/e2e/generators.ts.
 */

import type { Json } from "../../../e2e/gen-support.js";
import type { Rng } from "../../../e2e/prng.js";

export function genWorkflows(rng: Rng): Json[] {
  return Array.from({ length: rng.int(2) + 1 }, (_, i) => ({
    path: `.github/workflows/${rng.pick(["ci", "release", "lint"])}-${i}.yml`,
    state: rng.pick(["active", "disabled"] as const),
  }));
}
