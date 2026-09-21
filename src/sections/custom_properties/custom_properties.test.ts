import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "../../../src/github/api.js";
import type { SectionInput, SectionModule } from "../../../src/sections/contract/module.js";
import { planContext, type SectionPlan } from "../../../src/sections/contract/plan.js";
import { sectionModule } from "../../../src/sections/registry.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../test/sections/section-run.js";
import { validatedInput } from "../../../test/sections/validated-input.js";
import { customPropertiesSection, normalizeValue } from "./index.js";
import { customPropertiesMockHandlers } from "./mock.js";

/** The registered module: the owner gate the registry composes is part of the behavior under test. */
const gated = sectionModule("custom_properties") as SectionModule<"custom_properties"> &
  Required<Pick<SectionModule<"custom_properties">, "snapshot">>;

/** Routes for an org-owned repo with the given live property values. */
function orgRoutes(values: Array<{ property_name: string; value: unknown }>) {
  return {
    "GET /orgs/o": { data: { login: "o" } },
    "GET /repos/o/r/properties/values": { data: values },
  };
}

const plan = async (api: MockApi, desired: SectionInput<"custom_properties">) =>
  unwrap(
    await gated.plan(planContext(gated, api, REPO), validatedInput("custom_properties", desired)),
  );

/** The lines an op's change renders; the section builds them at plan time, so no response is needed. */
function changeLines(op: SectionPlan["ops"][number]): readonly string[] {
  return typeof op.change === "function" ? [unwrap(op.change(null))].flat() : [op.change];
}

/**
 * The derived fake refuses the org probe (the dispatcher resolves GET /orgs/{org} to teams, the first section declaring it), so it is answered here
 * from the seeded org.
 */
function orgFake(values: Array<{ property_name: string; value: unknown }>) {
  const fake = fragmentFake(customPropertiesSection, customPropertiesMockHandlers, {
    custom_property_values: values,
  });
  const api: GitHubClient = {
    ...fake,
    tryRequest: (method, path, payload) =>
      path === "/orgs/o"
        ? Promise.resolve({ data: fake.state.org })
        : fake.tryRequest(method, path, payload),
  };
  return { api, fake };
}

const live = [
  { property_name: "pilot", value: "false" },
  { property_name: "compliance", value: ["soc2"] },
  { property_name: "tier", value: "gold" },
];

describe("custom_properties", () => {
  test.each<
    [declared: Parameters<typeof normalizeValue>[0], wire: ReturnType<typeof normalizeValue>]
  >([
    [true, "true"],
    [false, "false"],
    [7, "7"],
    ["platform", "platform"],
    [
      ["soc2", "hipaa"],
      ["soc2", "hipaa"],
    ],
    [null, null],
  ])("normalizeValue(%j) is %j, GitHub's stored form", (declared, wire) => {
    expect(normalizeValue(declared)).toEqual(wire);
  });

  test("a personal account plans nothing but the note, with zero property calls", async () => {
    // The unrouted GET /orgs/o answers 404, the personal-account signal.
    const api = new MockApi({});
    const result = await plan(api, [{ property_name: "team", value: "platform" }]);
    expect(result).toEqual({
      ops: [],
      notes: [
        'custom_properties: owner "o" is a personal account, not an organization, so this section does not apply; section skipped - remove the custom_properties section from the settings file to silence this note',
      ],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /orgs/o"]);
  });

  test("plans ONE bulk PATCH folding set, change, unset, and undeclared unset, reading only", async () => {
    // A fake that would accept any write: the plan must still issue none.
    const api = new MockApi(orgRoutes(live), { unroutedMutations: "succeed" });
    const result = await plan(api, {
      _undeclared: "delete",
      entries: [
        { property_name: "team", value: "platform" },
        { property_name: "pilot", value: true },
        { property_name: "compliance", value: null },
      ],
    });
    expect(result.notes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.ops.map((op) => ({ ...op, change: changeLines(op) }))).toEqual([
      {
        role: "update",
        payload: {
          properties: [
            { property_name: "team", value: "platform" },
            { property_name: "pilot", value: "true" },
            { property_name: "compliance", value: null },
            { property_name: "tier", value: null },
          ],
        },
        describe: "updating custom property values",
        drift: [
          'custom_properties[team]: declared "platform" != live unset; apply will set the declared value',
          'custom_properties[pilot]: declared "true" != live "false"; apply will set the declared value',
          'custom_properties[compliance]: declared null but the live value is ["soc2"]; apply will unset it (reverting to the org default, if any)',
          'custom_properties[tier]: undeclared - not in the settings file and "_undeclared: delete" is set, so apply will unset it (reverting to the org default, if any); add it to the settings file to keep it',
        ],
        change: [
          'set custom property "team" to "platform"',
          'set custom property "pilot" to "true"',
          'unset custom property "compliance"',
          'unset undeclared custom property "tier"',
        ],
      },
    ]);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /orgs/o",
      "GET /repos/o/r/properties/values",
    ]);
  });

  test("under the keep default an undeclared live value is a note, beside the declared drift", async () => {
    const result = await plan(new MockApi(orgRoutes(live)), [
      { property_name: "compliance", value: ["soc2", "hipaa"] },
    ]);
    expect(result.ops.map((op) => op.drift)).toEqual([
      [
        'custom_properties[compliance]: declared ["soc2","hipaa"] != live ["soc2"]; apply will set the declared value',
      ],
    ]);
    expect(result.notes).toEqual([
      'custom property "pilot" is set on the repo but not declared in the settings file; kept under "_undeclared: keep" - add it to the settings file to manage it, or set "_undeclared: delete" to have apply UNSET it',
      'custom property "tier" is set on the repo but not declared in the settings file; kept under "_undeclared: keep" - add it to the settings file to manage it, or set "_undeclared: delete" to have apply UNSET it',
    ]);
  });

  test.each<[form: string, liveValues: typeof live, declared: Parameters<typeof plan>[1]]>([
    [
      "every declared value matches, null against an absent live entry included",
      live,
      [
        { property_name: "pilot", value: false },
        { property_name: "compliance", value: ["soc2"] },
        { property_name: "tier", value: "gold" },
        { property_name: "team", value: null },
      ],
    ],
    [
      "a multi_select list reordered",
      [{ property_name: "compliance", value: ["soc2", "hipaa"] }],
      [{ property_name: "compliance", value: ["hipaa", "soc2"] }],
    ],
    [
      "a live-side duplicate element GitHub would collapse",
      [{ property_name: "compliance", value: ["soc2", "soc2"] }],
      [{ property_name: "compliance", value: ["soc2"] }],
    ],
  ])("%s plans nothing", async (_form, liveValues, declared) => {
    expect(await plan(new MockApi(orgRoutes(liveValues)), declared)).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
  });

  test.each<[form: string, declared: Parameters<typeof plan>[1], issue: RegExp]>([
    [
      "a multi_select listing one option twice",
      [{ property_name: "compliance", value: ["soc2", "hipaa", "soc2"] }],
      /^\[0\]\.value: the "compliance" entry lists the value "soc2" more than once/,
    ],
    [
      "the same, in the wrapped form",
      {
        _undeclared: "delete",
        entries: [{ property_name: "compliance", value: ["soc2", "soc2"] }],
      },
      /^\.entries\[0\]\.value: the "compliance" entry lists the value "soc2" more than once/,
    ],
    [
      "an empty list",
      [{ property_name: "compliance", value: [] }],
      /^\[0\]\.value: the "compliance" entry declares an empty list; declare value: null/,
    ],
    [
      "two entries naming one property",
      [
        { property_name: "team", value: "a" },
        { property_name: "team", value: "b" },
      ],
      /^\[1\]\.property_name: "team" names the same custom property as "team" declared earlier/,
    ],
  ])(
    "%s is one validate issue at the offending field, so the document fails before the owner probe",
    (_form, declared, issue) => {
      expect(
        customPropertiesSection
          .validate(declared)
          .map((found) => `${found.path}: ${found.message}`),
      ).toEqual([expect.stringMatching(issue)]);
    },
  );

  test("a live entry without a string property_name fails loudly as a contract violation", async () => {
    const api = new MockApi(orgRoutes([{ value: "x" } as never]));
    await expect(plan(api, [{ property_name: "team", value: "x" }])).rejects.toThrow(
      /returned a body outside the documented shape - \[0\]\.property_name/,
    );
  });

  test("executing the plan against the mock fragment converges: the re-plan is empty", async () => {
    const { api, fake } = orgFake(live);
    const { second, changes, notes } = await provePlanIdempotent(customPropertiesSection, api, {
      _undeclared: "delete",
      entries: [
        { property_name: "team", value: "platform" },
        { property_name: "pilot", value: true },
        { property_name: "compliance", value: null },
      ],
    });
    expect(changes).toEqual([
      'set custom property "team" to "platform"',
      'set custom property "pilot" to "true"',
      'unset custom property "compliance"',
      'unset undeclared custom property "tier"',
    ]);
    expect(notes).toEqual([]);
    expect(fake.writes).toEqual(["PATCH /repos/o/r/properties/values"]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(fake.state.custom_property_values).toEqual([
      { property_name: "pilot", value: "true" },
      { property_name: "team", value: "platform" },
    ]);
  });

  test("the read port exposes the org probe in its absent posture and the values GET, never the PATCH", () => {
    const ctx = planContext(customPropertiesSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["org", "list"]);
    // @ts-expect-error a write role is not a read: the port has no `update`
    ctx.read.update;
    // @ts-expect-error an "absent" primary read offers no throwing helper
    ctx.read.org.call;
  });
});
