/**
 * The milestones fuzz generator fragment and witness.
 */

import { dueOnWire } from "../../../../src/sections/milestones/index.js";
import { MilestoneConfig } from "../../../../src/sections/milestones/schema.js";
import {
  assertSentinelDisjoint,
  DRIFT_DESCRIPTION,
  generatorFromSlice,
  genName,
  type Json,
  type LiveWitness,
  type LiveWitnessKind,
  uniqueBy,
} from "../../../e2e/gen-support.js";
import type { Rng } from "../../../e2e/prng.js";
import { githubStoresDueOn } from "./mock.js";

/** A fixed pool, never Date.now, so generation stays deterministic; one day per DST state and one at the year's edge. */
const DUE_DATES = ["2026-01-15", "2026-06-30", "2026-12-31"] as const;

const genMilestone = generatorFromSlice(MilestoneConfig, {
  fields: {
    title: (rng) => rng.pick(["v1", "v2", "backlog"]),
    description: (rng) => rng.pick(["", "the milestone", genName(rng)]),
    due_on: (rng) => rng.pick(DUE_DATES),
  },
  present: { due_on: 0.4 },
});

export function genMilestones(rng: Rng): Json[] {
  return uniqueBy(
    Array.from({ length: rng.int(3) + 1 }, () => genMilestone(rng)),
    ["title"],
  );
}

/** The day as GitHub has it stored after the section wrote it: Pacific midnight, not the declared spelling. */
function storedDueOn(day: string): string {
  return githubStoresDueOn(dueOnWire(day));
}

/** Every declared field is compared, so the whole declaration is spread over the server defaults. */
function matchingLiveMilestone(milestone: Json, index: number): Json {
  const { due_on, ...declared } = milestone;
  return {
    id: 910_000 + index,
    number: index + 1,
    state: "open",
    description: null,
    ...declared,
    due_on: typeof due_on === "string" ? storedDueOn(due_on) : null,
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
    live.due_on = storedDueOn(rng.pick(DUE_DATES.filter((d) => d !== source.due_on)));
  }
  return { kind: "drift-update", state: { milestones } };
}
