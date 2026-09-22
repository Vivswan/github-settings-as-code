import { describe, expect, test } from "bun:test";
import type { SectionInput } from "../../../../src/sections/contract/module.js";
import { planContext } from "../../../../src/sections/contract/plan.js";
import { milestonesSection } from "../../../../src/sections/milestones/index.js";
import { MockApi } from "../../../mock-api.js";
import { fragmentFake } from "../../../sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../sections/section-run.js";
import { validatedInput } from "../../../sections/validated-input.js";
import { githubStoresDueOn, milestonesMockHandlers } from "./mock.js";

/** Closed milestones are listed too: the read asks for state=all. */
const LIST = "GET /repos/o/r/milestones?state=all&per_page=100&page=1";
const liveMilestones = [
  { number: 1, title: "v1", description: null, state: "open", due_on: null },
  { number: 2, title: "old", description: null, state: "open", due_on: null },
];
const KEEP_NOTE =
  'milestone "old" exists on the repo but is not declared in the settings file; kept under ' +
  '"_undeclared: keep" - add it to the settings file to manage it, or set "_undeclared: delete" ' +
  "to have apply DELETE it, detaching it from every issue that carries it (closing is not " +
  "enough; closed milestones are still listed)";
const plan = async (api: MockApi, desired: SectionInput<"milestones">) =>
  unwrap(
    await milestonesSection.plan(
      planContext(milestonesSection, api, REPO),
      validatedInput("milestones", desired),
    ),
  );

describe("milestones", () => {
  test("plans an update per drifted milestone and a create per missing one, keeps the undeclared one as a note, reading only", async () => {
    const api = new MockApi({ [LIST]: { data: liveMilestones } });
    const result = await plan(api, [
      { title: "v1", description: "first", state: "closed" },
      { title: "v2" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { milestone_number: "1" },
          payload: { title: "v1", description: "first", state: "closed" },
          describe: 'updating milestone "v1"',
          drift: [
            'milestones[v1].description: declared "first" != live null; apply will set the declared value',
            'milestones[v1].state: declared "closed" != live "open"; apply will set the declared value',
          ],
          change: 'updated milestone "v1"',
        },
        {
          role: "create",
          payload: { title: "v2" },
          describe: 'creating milestone "v2"',
          drift: [
            "milestones[v2]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created milestone "v2"',
        },
      ],
      notes: [KEEP_NOTE],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([LIST]);
  });

  test("a due_on differing by a day, or missing live, is drift on the day, and the update sends the day as noon UTC so GitHub keeps that day", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          {
            number: 1,
            title: "v1",
            description: null,
            state: "open",
            due_on: "2026-01-15T08:00:00Z",
          },
          { number: 2, title: "v2", description: null, state: "open", due_on: null },
        ],
      },
    });
    const result = await plan(api, [
      { title: "v1", due_on: "2026-01-16" },
      { title: "v2", due_on: "2026-12-31" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { milestone_number: "1" },
          payload: { title: "v1", due_on: "2026-01-16T12:00:00Z" },
          describe: 'updating milestone "v1"',
          drift: [
            'milestones[v1].due_on: declared "2026-01-16" != live "2026-01-15"; apply will set the declared value',
          ],
          change: 'updated milestone "v1"',
        },
        {
          role: "update",
          params: { milestone_number: "2" },
          payload: { title: "v2", due_on: "2026-12-31T12:00:00Z" },
          describe: 'updating milestone "v2"',
          drift: [
            'milestones[v2].due_on: declared "2026-12-31" != live null; apply will set the declared value',
          ],
          change: 'updated milestone "v2"',
        },
      ],
      notes: [],
      drift: [],
    });
  });

  test.each([
    [
      "2022-11-14T07:00:00Z",
      "2022-11-13T08:00:00Z",
      "07:00Z is still the 13th under PST, the reported off-by-one",
    ],
    [
      "2026-01-15T00:00:00Z",
      "2026-01-14T08:00:00Z",
      "a UTC midnight is the previous evening in Pacific",
    ],
    ["2026-01-15T12:00:00Z", "2026-01-15T08:00:00Z", "noon UTC keeps its day under PST"],
    ["2026-07-01T12:00:00Z", "2026-07-01T07:00:00Z", "noon UTC keeps its day under PDT"],
    ["2026-07-01T07:00:00Z", "2026-07-01T07:00:00Z", "a stored value is a fixed point"],
  ])("the mock stores due_on %s as GitHub does, %s: %s", (sent, stored) => {
    expect(githubStoresDueOn(sent)).toBe(stored);
  });

  test.each<
    [
      form: string,
      declared: SectionInput<"milestones">,
      ops: Awaited<ReturnType<typeof plan>>["ops"],
      notes: string[],
    ]
  >([
    [
      "wrapped _undeclared:delete",
      { _undeclared: "delete", entries: [{ title: "v1" }] },
      [
        {
          role: "remove",
          params: { milestone_number: "2" },
          describe: 'deleting undeclared milestone "old"',
          drift: [
            'milestones[old]: undeclared - not in the settings file and "_undeclared: delete" is set, so apply will DELETE it, detaching it from every issue that carries it; add it to the settings file to keep it',
          ],
          change: 'DELETED undeclared milestone "old"',
        },
      ],
      [],
    ],
    ["the wrapper without a policy", { entries: [{ title: "v1" }] }, [], [KEEP_NOTE]],
    ["the plain list", [{ title: "v1" }], [], [KEEP_NOTE]],
  ])(
    "%s resolves the undeclared milestone against the keep default, naming the detach consequence",
    async (_form, declared, ops, notes) => {
      const api = new MockApi({ [LIST]: { data: liveMilestones } });
      const result = await plan(api, declared);
      expect(result).toEqual({ ops, notes, drift: [] });
    },
  );

  test("executing the plan against the mock converges: the re-plan is empty", async () => {
    const api = fragmentFake(milestonesSection, milestonesMockHandlers, {
      milestones: [
        {
          id: 900001,
          number: 1,
          state: "open",
          title: "v0.9",
          description: "Old preview.",
          due_on: null,
        },
        {
          id: 900002,
          number: 7,
          state: "open",
          title: "v1.0",
          description: "Outdated description.",
          due_on: "2026-01-15T08:00:00Z",
        },
      ],
    });
    const { second, changes, notes } = await provePlanIdempotent(milestonesSection, api, {
      _undeclared: "delete",
      entries: [
        { title: "v1.0", description: "First stable release.", due_on: "2026-06-30" },
        { title: "v2.0", state: "closed" },
      ],
    });
    expect(changes).toEqual([
      'DELETED undeclared milestone "v0.9"',
      'updated milestone "v1.0"',
      'created milestone "v2.0"',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "DELETE /repos/o/r/milestones/1",
      "PATCH /repos/o/r/milestones/7",
      "POST /repos/o/r/milestones",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    // The mock stored the day as GitHub does: Pacific midnight, in PDT for June.
    expect(api.state.milestones.map((m) => [m.title, m.description, m.state, m.due_on])).toEqual([
      ["v1.0", "First stable release.", "open", "2026-06-30T07:00:00Z"],
      ["v2.0", null, "closed", null],
    ]);
  });
});
