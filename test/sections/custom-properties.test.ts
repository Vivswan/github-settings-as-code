import { describe, expect, test } from "bun:test";
import { customPropertiesSection, normalizeValue } from "../../src/sections/custom-properties.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("normalizeValue", () => {
  test("booleans and numbers become their string form (GitHub's true_false wire shape)", () => {
    expect(normalizeValue(true)).toBe("true");
    expect(normalizeValue(false)).toBe("false");
    expect(normalizeValue(7)).toBe("7");
  });

  test("strings, string lists, and null pass through (lists element-wise)", () => {
    expect(normalizeValue("platform")).toBe("platform");
    expect(normalizeValue(["soc2", "hipaa"])).toEqual(["soc2", "hipaa"]);
    expect(normalizeValue(null)).toBeNull();
  });
});

/** Routes for an org-owned repo with the given live property values. */
function orgRoutes(values: Array<{ property_name: string; value: unknown }>) {
  return {
    "GET /orgs/o": { data: { login: "o" } },
    "GET /repos/o/r/properties/values": { data: values },
  };
}

const PATCH_PATH = "PATCH /repos/o/r/properties/values";

describe("custom_properties", () => {
  const live = [
    { property_name: "pilot", value: "false" },
    { property_name: "compliance", value: ["soc2"] },
    { property_name: "tier", value: "gold" },
  ];

  test("a personal account no-ops with a note and zero property calls", async () => {
    // The unrouted GET /orgs/o answers 404, the personal-account signal.
    const api = new MockApi({});
    const result = await customPropertiesSection.run(ctx(api), [
      { property_name: "team", value: "platform" },
    ]);
    expect(result.notes[0]).toContain("organization-owned repository");
    expect(api.mutations()).toEqual([]);
    expect(api.calls.map((c) => c.path)).toEqual(["/orgs/o"]);
  });

  test("apply folds set, change, and unset into ONE bulk PATCH", async () => {
    const api = new MockApi(orgRoutes(live)).allowMutations(PATCH_PATH);
    const result = await customPropertiesSection.run(ctx(api), {
      undeclared: "delete",
      entries: [
        { property_name: "team", value: "platform" },
        { property_name: "pilot", value: true },
        { property_name: "compliance", value: null },
      ],
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PATCH /repos/o/r/properties/values",
    ]);
    expect(api.mutations()[0]?.payload).toEqual({
      properties: [
        { property_name: "team", value: "platform" },
        { property_name: "pilot", value: "true" },
        { property_name: "compliance", value: null },
        { property_name: "tier", value: null },
      ],
    });
    expect(result.changes).toEqual([
      'set custom property "team" to "platform"',
      'set custom property "pilot" to "true"',
      'unset custom property "compliance"',
      'unset undeclared custom property "tier"',
    ]);
  });

  test("no PATCH at all when every declared value already matches", async () => {
    const api = new MockApi(orgRoutes(live));
    const result = await customPropertiesSection.run(ctx(api), [
      { property_name: "pilot", value: false },
      { property_name: "compliance", value: ["soc2"] },
      { property_name: "tier", value: "gold" },
      { property_name: "team", value: null },
    ]);
    expect(result.changes).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("multi_select lists compare order-insensitively", async () => {
    const api = new MockApi(orgRoutes([{ property_name: "compliance", value: ["soc2", "hipaa"] }]));
    const result = await customPropertiesSection.run(ctx(api, true), [
      { property_name: "compliance", value: ["hipaa", "soc2"] },
    ]);
    expect(result.drift).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("a live-side duplicate element still converges (no perpetual rewrite)", async () => {
    // GitHub may collapse a duplicated multi_select option; if the section
    // compared multisets, declared ["soc2"] vs live ["soc2","soc2"] would
    // PATCH on every apply and never converge. Set membership must read it
    // as equal in both modes: check clean, apply write-free.
    const routes = orgRoutes([{ property_name: "compliance", value: ["soc2", "soc2"] }]);
    const declared = [{ property_name: "compliance", value: ["soc2"] }];
    const checked = await customPropertiesSection.run(ctx(new MockApi(routes), true), declared);
    expect(checked.drift).toEqual([]);
    const applyApi = new MockApi(routes);
    const applied = await customPropertiesSection.run(ctx(applyApi), declared);
    expect(applied.changes).toEqual([]);
    expect(applyApi.mutations()).toEqual([]);
  });

  test("a genuinely different set still drifts", async () => {
    const api = new MockApi(orgRoutes([{ property_name: "compliance", value: ["soc2", "soc2"] }]));
    const result = await customPropertiesSection.run(ctx(api, true), [
      { property_name: "compliance", value: ["soc2", "hipaa"] },
    ]);
    expect(result.drift).toEqual([
      'custom_properties[compliance]: declared ["soc2","hipaa"] != live ["soc2","soc2"]; apply will set the declared value',
    ]);
  });

  test("a declared multi_select listing the same option twice is rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      customPropertiesSection.run(ctx(api), [
        { property_name: "compliance", value: ["soc2", "hipaa", "soc2"] },
      ]),
    ).rejects.toThrow(/"compliance" entry lists the value "soc2" more than once/);
    expect(api.calls).toHaveLength(0);
  });

  test("the duplicate-element rejection fires for the wrapped form too", async () => {
    // Pins that the check runs AFTER undeclaredPolicy unwraps the entries.
    const api = new MockApi({});
    await expect(
      customPropertiesSection.run(ctx(api), {
        undeclared: "delete",
        entries: [{ property_name: "compliance", value: ["soc2", "soc2"] }],
      }),
    ).rejects.toThrow(/"compliance" entry lists the value "soc2" more than once/);
    expect(api.calls).toHaveLength(0);
  });

  test("a declared empty list is rejected before any API call", async () => {
    // GitHub does not document whether [] stores or normalizes to unset, so
    // it could re-write forever; value: null is the documented unset.
    const api = new MockApi({});
    await expect(
      customPropertiesSection.run(ctx(api), [{ property_name: "compliance", value: [] }]),
    ).rejects.toThrow(/"compliance" entry declares an empty list; declare value: null/);
    expect(api.calls).toHaveLength(0);
  });

  test("check mode reports every drift kind without mutating", async () => {
    const api = new MockApi(orgRoutes(live));
    const result = await customPropertiesSection.run(ctx(api, true), [
      { property_name: "team", value: "platform" },
      { property_name: "pilot", value: true },
      { property_name: "compliance", value: null },
    ]);
    expect(result.drift).toEqual([
      'custom_properties[team]: declared "platform" != live unset; apply will set the declared value',
      'custom_properties[pilot]: declared "true" != live "false"; apply will set the declared value',
      'custom_properties[compliance]: declared null but the live value is ["soc2"]; apply will unset it (reverting to the org default, if any)',
    ]);
    // "tier" is undeclared and kept by default, as a note.
    expect(result.notes).toEqual([
      'custom property "tier" is set on the repo but not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply UNSET it',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("check mode under undeclared:delete drifts on the undeclared live value", async () => {
    const api = new MockApi(orgRoutes([{ property_name: "tier", value: "gold" }]));
    const result = await customPropertiesSection.run(ctx(api, true), {
      undeclared: "delete",
      entries: [],
    });
    expect(result.drift).toEqual([
      "custom_properties[tier]: undeclared - not in the settings file, so apply will unset it (reverting to the org default, if any); add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("two entries naming the same property are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      customPropertiesSection.run(ctx(api), [
        { property_name: "team", value: "a" },
        { property_name: "team", value: "b" },
      ]),
    ).rejects.toThrow(/same custom_properties entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("a live entry without a string property_name fails loudly as a contract violation", async () => {
    const api = new MockApi(orgRoutes([{ value: "x" } as never]));
    await expect(
      customPropertiesSection.run(ctx(api, true), [{ property_name: "team", value: "x" }]),
    ).rejects.toThrow(/returned an entry without a string property_name/);
  });
});
