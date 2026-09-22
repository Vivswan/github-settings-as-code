/**
 * The milestones e2e mock fragment, derived from the section's declaration by
 * test/e2e/mock/list-fragment.ts; only the server-owned facts live here.
 */

import { milestonesSection } from "../../../../src/sections/milestones/index.js";
import { type ListMockSpec, mockFragmentFor } from "../../../e2e/mock/list-fragment.js";
import { nextNumber, type SectionRestHandlers } from "../../../e2e/mock/support.js";

const PACIFIC = "America/Los_Angeles";
const pacificDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: PACIFIC,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const pacificHour = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC,
  hour: "numeric",
  hourCycle: "h23",
});

/**
 * Stores a due_on the way GitHub does (the rule is at DueOnWire in index.ts), so a value only converges
 * when the section sends a day GitHub keeps.
 *
 *   2022-11-14T07:00:00Z -> 2022-11-13T08:00:00Z   (PST: 07:00Z is still the 13th there)
 *   2026-07-01T12:00:00Z -> 2026-07-01T07:00:00Z   (PDT)
 */
export function githubStoresDueOn(sent: string): string {
  const day = pacificDay.format(new Date(sent));
  // Midnight on `day` is 08:00Z under PST and 07:00Z under PDT, so 08:00Z reads as hour 0 or hour 1 there.
  const hour = Number(pacificHour.format(new Date(`${day}T08:00:00Z`)));
  return `${day}T${hour === 0 ? "08" : "07"}:00:00Z`;
}

/** The number is GitHub's per-repository sequence: a seed may pin one, a created milestone takes the next. */
export const MILESTONES_MOCK: ListMockSpec = {
  collection: (state) => state.milestones,
  defaults: { state: "open", description: null },
  owned: (id, _slug, milestone, siblings) => ({
    id,
    number: typeof milestone.number === "number" ? milestone.number : nextNumber(siblings),
    due_on: typeof milestone.due_on === "string" ? githubStoresDueOn(milestone.due_on) : null,
  }),
  unique: "identity",
};

export const milestonesMockHandlers: SectionRestHandlers<"milestones"> = mockFragmentFor(
  milestonesSection,
  MILESTONES_MOCK,
);
