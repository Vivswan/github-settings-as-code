/**
 * The teams fuzz generator fragment. It imports test-tree seams on purpose: the bundle entry is
 * src/main.ts, so this file never reaches lib/index.js.
 */

import { generatorFromSlice, type Json, uniqueBy } from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";
import { TeamsConfig } from "./schema.js";

const genTeam = generatorFromSlice(TeamsConfig.element, {
  fields: {
    name: (rng) => rng.pick(["core", "reviewers", "ops"]),
    permission: (rng) => rng.pick(["pull", "push", "maintain", "admin"]),
  },
  present: { permission: 0.8 },
});

export function genTeams(rng: Rng): Json[] {
  const teams = Array.from({ length: rng.int(2) + 1 }, () => genTeam(rng));
  return uniqueBy(teams, ["name"], (slug) => slug.toLowerCase());
}
