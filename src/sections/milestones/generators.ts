/**
 * The milestones fuzz generator fragment and witness. It imports test-tree seams on purpose: the
 * bundle entry is src/main.ts, so this file never reaches lib/index.js.
 */

import {
  assertSentinelDisjoint,
  DRIFT_DESCRIPTION,
  generatorFromSlice,
  genName,
  type Json,
  type LiveWitness,
  type LiveWitnessKind,
  uniqueBy,
} from "../../../test/e2e/gen-support.js";
import type { Rng } from "../../../test/e2e/prng.js";
import { MilestoneConfig } from "./schema.js";

/** A fixed pool, never Date.now, so generation stays deterministic. */
const DUE_DATES = ["2026-01-15T00:00:00Z", "2026-06-30T00:00:00Z", "2026-12-31T00:00:00Z"] as const;

const genMilestone = generatorFromSlice(MilestoneConfig, {
  fields: {
    title: (rng) => rng.pick(["v1", "v2", "backlog"]),
    description: (rng) => rng.pick(["", "the milestone", genName(rng)]),
  },
});

export function genMilestones(rng: Rng): Json[] {
  const milestones = Array.from({ length: rng.int(3) + 1 }, () => {
    const milestone = genMilestone(rng);
    // due_on is a passthrough field the slice does not name, sent verbatim and compared to the echo.
    if (rng.bool(0.4)) {
      milestone.due_on = rng.pick(DUE_DATES);
    }
    return milestone;
  });
  return uniqueBy(milestones, ["title"]);
}

/** Passthrough fields (due_on) are compared too, so the whole declaration is spread over the server defaults. */
function matchingLiveMilestone(milestone: Json, index: number): Json {
  return {
    id: 910_000 + index,
    number: index + 1,
    state: "open",
    description: null,
    ...milestone,
  };
}

function milestoneDriftFields(milestone: Json): Array<"description" | "state" | "due_on"> {
  const fields: Array<"description" | "state" | "due_on"> = [];
  if (milestone.description !== undefined) {
    fields.push("description");
  }
  if (milestone.state !== undefined) {
    fields.push("state");
  }
  if (milestone.due_on !== undefined) {
    fields.push("due_on");
  }
  return fields;
}

export function milestonesWitness(rng: Rng, declared: Json[], kind: LiveWitnessKind): LiveWitness {
  const milestones = declared.map(matchingLiveMilestone);
  if (kind === "matching") {
    return { kind, state: { milestones } };
  }
  const eligible = declared
    .map((milestone, index) => ({ index, fields: milestoneDriftFields(milestone) }))
    .filter((entry) => entry.fields.length > 0);
  if (eligible.length === 0) {
    // Every milestone declares only its title, so no field can legitimately diverge.
    return { kind: "matching", state: { milestones } };
  }
  // Every eligible sentinel stays disjoint per build, not only the one picked (state and due_on
  // are disjoint by construction: each draws away from the declared value).
  for (const entry of eligible) {
    assertSentinelDisjoint(
      (declared[entry.index] as Json).description !== DRIFT_DESCRIPTION,
      `the milestone description pool contains "${DRIFT_DESCRIPTION}"`,
    );
  }
  const { index, fields } = rng.pick(eligible);
  const source = declared[index] as Json;
  const live = milestones[index] as Json;
  const field = rng.pick(fields);
  if (field === "description") {
    live.description = DRIFT_DESCRIPTION;
  } else if (field === "state") {
    live.state = source.state === "open" ? "closed" : "open";
  } else {
    live.due_on = rng.pick(DUE_DATES.filter((d) => d !== source.due_on));
  }
  return { kind: "drift-update", state: { milestones } };
}
