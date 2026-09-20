import { describe, expect, test } from "bun:test";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { milestonesSection } from "./index.js";
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
const plan = (api: MockApi, desired: Parameters<typeof milestonesSection.plan>[1]) =>
  milestonesSection.plan(planContext(milestonesSection, api, REPO), desired);

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

  test("a matching milestone plans nothing: a declared empty description reads as the live null", async () => {
    const api = new MockApi({ [LIST]: { data: liveMilestones } });
    const result = await plan(api, {
      _undeclared: "keep",
      entries: [
        { title: "v1", description: "" },
        { title: "old", state: "open" },
      ],
    });
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a declared key the live milestone lacks is drift plus a phantom note beside the update", async () => {
    const api = new MockApi({ [LIST]: { data: liveMilestones } });
    const result = await plan(api, {
      _undeclared: "keep",
      entries: [{ title: "v1", due_date: "2026-01-15" } as never],
    });
    expect(result.ops.map((op) => [op.role, op.payload, op.drift])).toEqual([
      [
        "update",
        { title: "v1", due_date: "2026-01-15" },
        [
          'milestones[v1].due_date: declared "2026-01-15" but the API response has no such field (new or write-only field?)',
        ],
      ],
    ]);
    expect(result.notes).toEqual([
      'milestones[v1]: declared key "due_date" does not exist on the live milestone, so if GitHub ignores it this update will re-run on every apply without converging. Fix the key name, or remove it from the settings file',
      KEEP_NOTE,
    ]);
  });

  test("a declared day matches the Pacific-midnight timestamp GitHub stores it as, in either DST state, so no PATCH recurs", async () => {
    const api = new MockApi({
      [LIST]: {
        data: [
          {
            number: 1,
            title: "winter",
            description: null,
            state: "open",
            due_on: "2026-01-15T08:00:00Z",
          },
          {
            number: 2,
            title: "summer",
            description: null,
            state: "open",
            due_on: "2026-07-01T07:00:00Z",
          },
        ],
      },
    });
    const result = await plan(api, [
      { title: "winter", due_on: "2026-01-15" },
      // A timestamp declares the same day: GitHub would discard its time anyway.
      { title: "summer", due_on: "2026-07-01T00:00:00Z" },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a due_on differing by a day, or missing live, is drift, and the update sends the day as noon UTC so GitHub keeps that day", async () => {
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
            'milestones[v1].due_on: declared "2026-01-16T12:00:00Z" != live "2026-01-15T12:00:00Z"; apply will set the declared value',
          ],
          change: 'updated milestone "v1"',
        },
        {
          role: "update",
          params: { milestone_number: "2" },
          payload: { title: "v2", due_on: "2026-12-31T12:00:00Z" },
          describe: 'updating milestone "v2"',
          drift: [
            'milestones[v2].due_on: declared "2026-12-31T12:00:00Z" != live null; apply will set the declared value',
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
      declared: Parameters<typeof milestonesSection.plan>[1],
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

  test("duplicate titles are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(plan(api, [{ title: "v1" }, { title: "v1", state: "closed" }])).rejects.toThrow(
      /same milestones entry/,
    );
    expect(api.calls).toHaveLength(0);
  });

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
      'updated milestone "v1.0"',
      'created milestone "v2.0"',
      'DELETED undeclared milestone "v0.9"',
    ]);
    expect(notes).toEqual([]);
    expect(api.writes).toEqual([
      "PATCH /repos/o/r/milestones/7",
      "POST /repos/o/r/milestones",
      "DELETE /repos/o/r/milestones/1",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    // The mock stored the day as GitHub does: Pacific midnight, in PDT for June.
    expect(api.state.milestones.map((m) => [m.title, m.description, m.state, m.due_on])).toEqual([
      ["v1.0", "First stable release.", "open", "2026-06-30T07:00:00Z"],
      ["v2.0", null, "closed", null],
    ]);
  });

  test("the read port exposes exactly the list role in its denied posture", () => {
    const ctx = planContext(milestonesSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["list"]);
    // @ts-expect-error a write role is not a read: the port has no `create`
    ctx.read.create;
    // @ts-expect-error nor an `update`
    ctx.read.update;
    // @ts-expect-error nor a `remove`
    ctx.read.remove;
    // @ts-expect-error a "denied" primary read offers no 404-tolerant helper
    ctx.read.list.probeAbsent;
  });
});
