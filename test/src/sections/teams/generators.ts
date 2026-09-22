/**
 * The teams fuzz generator fragment.
 */

import { TeamConfig } from "../../../../src/sections/teams/schema.js";
import { generatorFromSlice, type Json, uniqueBy } from "../../../e2e/gen-support.js";
import type { Rng } from "../../../e2e/prng.js";

const genTeam = generatorFromSlice(TeamConfig, {
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
