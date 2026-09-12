/**
 * The round-trip proof for a section's snapshot(): read the seeded live state back as a settings
 * value, plan that value against the same state, and require the plan to be converged - no drift,
 * no operation beyond the ones the declarations say recur - so a snapshot applies as a no-op. The
 * snapshot's own requests must all be reads. Reuses the plan-idempotence bench.
 */

import { expect } from "bun:test";
import type { SectionModule, SectionSnapshot } from "../../src/sections/contract/module.js";
import { planContext, planDrift, type SectionPlan } from "../../src/sections/contract/plan.js";
import type { LiveState } from "../e2e/mock/state.js";
import type { FragmentFake } from "./fragment-fake.js";
import { identityOf, unconvergedOps } from "./plan-idempotence.js";
import { REPO } from "./section-run.js";

/** A section module that declares snapshot(). */
export type SnapshotSection = SectionModule & Required<Pick<SectionModule, "snapshot">>;

/** One section's enrolment in the proof: test/sections/snapshot-rows/<key>.ts exports it as `row`. */
export interface Row {
  readonly section: SnapshotSection;
  /** The live state seeded into the mock; must hold at least one resource of the section's. */
  readonly live: LiveState;
  /** The whole snapshot the seeded state reads back as. */
  readonly expected: { value: unknown; notes: string[] };
}

export async function proveSnapshotRoundTrip(
  section: SnapshotSection,
  api: FragmentFake,
): Promise<{ snapshot: SectionSnapshot; plan: SectionPlan }> {
  const ctx = planContext(section, api, REPO);
  const snapshot = await section.snapshot(ctx);
  expect(api.writes, `${section.key}: snapshot() issued a write`).toEqual([]);
  if (snapshot.value === undefined) {
    throw new Error(
      `${section.key}: the seeded live state produced no snapshot value, so there is nothing to round-trip; seed at least one resource`,
    );
  }
  const plan = await section.plan(ctx, snapshot.value);
  expect(
    planDrift(plan),
    `${section.key}: the snapshot value drifts from the live state it was read from, so the projection does not match the section's write shape`,
  ).toEqual([]);
  expect(
    unconvergedOps(section, plan).map(identityOf),
    `${section.key}: planning the snapshot value carries operations that are neither alwaysRewrite by declaration nor unverifiable, so applying a snapshot would not be a no-op`,
  ).toEqual([]);
  expect(api.writes, `${section.key}: plan() issued a write`).toEqual([]);
  return { snapshot, plan };
}
