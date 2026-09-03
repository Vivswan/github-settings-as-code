/**
 * The milestones fuzz fragment: the entry generator walks the MilestoneConfig slice, so only the
 * corpus invariants live here (one entry per title, a passthrough due_on, the witness pools).
 * Imports only the test-tree seams; the bundle entry is src/main.ts, so this never reaches lib/index.js.
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

/** Fixed ISO due dates: a pool, never Date.now, so generation stays deterministic. */
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
  // One entry per title (the section's own rule). milestones is a WITNESS
  // section: always the plain array form, never maybeWrapUndeclared.
  return uniqueBy(milestones, ["title"]);
}

/**
 * A live milestone body the section reads as EXACTLY matching: every declared field, passthrough
 * included, is compared verbatim, so the whole declaration is spread over the server defaults.
 */
function matchingLiveMilestone(milestone: Json, index: number): Json {
  return {
    id: 910_000 + index,
    number: index + 1,
    state: "open",
    description: null,
    ...milestone,
  };
}

/** The fields of one declared milestone a drift-update witness may perturb. */
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
    // Every milestone declares only its title: no field can legitimately
    // diverge, so the witness degrades to matching (and says so).
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
