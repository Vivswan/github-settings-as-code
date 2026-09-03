/**
 * The teams fuzz fragment: the entry generator walks the team slice, so a new schema field is
 * fuzzed without an edit here; only the slug pool and the unique-slug invariant live in this file.
 * Imports only the test-tree seams; the bundle entry is src/main.ts, so this never reaches lib/index.js.
 */

import { generatorFromSlice, type Json } from "../../../test/e2e/gen-support.js";
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
  const count = rng.int(2) + 1;
  const claimed = new Set<string>();
  const teams: Json[] = [];
  for (let i = 0; i < count; i++) {
    const team = genTeam(rng);
    // The section's own rule: one entry per slug, case-insensitively.
    let name = String(team.name);
    while (claimed.has(name.toLowerCase())) {
      name = `${name}-${i}`;
    }
    claimed.add(name.toLowerCase());
    team.name = name;
    teams.push(team);
  }
  return teams;
}
