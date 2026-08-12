import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { actionsVariablesSection, variableKey } from "./index.js";

describe("variableKey", () => {
  test("uppercases (GitHub stores variable names uppercased)", () => {
    expect(variableKey("deploy_region")).toBe("DEPLOY_REGION");
  });
});

/** The enveloped list body the mock serves for a live variable set. */
function listRoute(variables: Array<{ name: string; value: string }>) {
  return {
    "GET /repos/o/r/actions/variables?per_page=30&page=1": {
      data: { total_count: variables.length, variables },
    },
  };
}

describe("actions_variables", () => {
  const liveVariables = [
    { name: "DEPLOY_REGION", value: "us-east-1" },
    { name: "RETIRED_FLAG", value: "off" },
  ];

  test("creates missing, updates drifted, deletes undeclared", async () => {
    const api = new MockApi(listRoute(liveVariables)).allowMutations(
      "POST /repos/o/r/actions/variables",
      "PATCH /repos/o/r/actions/variables/*",
      "DELETE /repos/o/r/actions/variables/*",
    );
    const result = await actionsVariablesSection.run(ctx(api), [
      { name: "DEPLOY_REGION", value: "eu-west-1" },
      { name: "BUILD_MODE", value: "release" },
    ]);
    expect(result.changes).toEqual([
      'updated Actions variable "DEPLOY_REGION"',
      'created Actions variable "BUILD_MODE"',
      'DELETED undeclared Actions variable "RETIRED_FLAG"',
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PATCH /repos/o/r/actions/variables/DEPLOY_REGION",
      "POST /repos/o/r/actions/variables",
      "DELETE /repos/o/r/actions/variables/RETIRED_FLAG",
    ]);
    // The update sends the value only; the create sends name + value.
    expect(api.mutations()[0]?.payload).toEqual({ value: "eu-west-1" });
    expect(api.mutations()[1]?.payload).toEqual({ name: "BUILD_MODE", value: "release" });
  });

  test("matches names case-insensitively: a lowercase declaration converges against the uppercase live name", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await actionsVariablesSection.run(ctx(api), [
      { name: "deploy_region", value: "us-east-1" },
      { name: "Retired_Flag", value: "off" },
    ]);
    expect(result.changes).toEqual([]);
    // An apply-mode result has no drift list at all (the mode-split types).
    expect(result.drift).toBeUndefined();
    expect(api.mutations()).toEqual([]);
  });

  test("the update PATCHes the LIVE (uppercase) name even when declared lowercase", async () => {
    const api = new MockApi(listRoute(liveVariables)).allowMutations(
      "PATCH /repos/o/r/actions/variables/*",
      "DELETE /repos/o/r/actions/variables/*",
    );
    await actionsVariablesSection.run(ctx(api), [
      { name: "deploy_region", value: "eu-west-1" },
      { name: "RETIRED_FLAG", value: "off" },
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PATCH /repos/o/r/actions/variables/DEPLOY_REGION",
    ]);
  });

  test("two entries differing only in case are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      actionsVariablesSection.run(ctx(api), [
        { name: "deploy_region", value: "a" },
        { name: "DEPLOY_REGION", value: "b" },
      ]),
    ).rejects.toThrow(/same actions_variables entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("check mode reports drift without mutating", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await actionsVariablesSection.run(ctx(api, true), [
      { name: "DEPLOY_REGION", value: "eu-west-1" },
      { name: "BUILD_MODE", value: "release" },
    ]);
    expect(result.drift).toEqual([
      'actions_variables[DEPLOY_REGION].value: declared "eu-west-1" != live "us-east-1"; apply will set the declared value',
      "actions_variables[BUILD_MODE]: missing - declared in the settings file but not on the repo; apply will create it",
      "actions_variables[RETIRED_FLAG]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("wrapped undeclared:keep leaves the undeclared variable as a note, never a DELETE", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await actionsVariablesSection.run(ctx(api), {
      undeclared: "keep",
      entries: [{ name: "DEPLOY_REGION", value: "us-east-1" }],
    });
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([
      'Actions variable "RETIRED_FLAG" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("wrapped undeclared:keep in check mode notes the undeclared variable instead of drifting", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await actionsVariablesSection.run(ctx(api, true), {
      undeclared: "keep",
      entries: [{ name: "DEPLOY_REGION", value: "us-east-1" }],
    });
    expect(result.drift).toEqual([]);
    expect(result.notes).toHaveLength(1);
  });

  test("the wrapper without a policy keeps the delete default", async () => {
    const api = new MockApi(listRoute(liveVariables)).allowMutations(
      "DELETE /repos/o/r/actions/variables/*",
    );
    const result = await actionsVariablesSection.run(ctx(api), {
      entries: [{ name: "DEPLOY_REGION", value: "us-east-1" }],
    });
    expect(result.changes).toEqual(['DELETED undeclared Actions variable "RETIRED_FLAG"']);
  });

  test("an explicit undeclared:delete deletes in apply and drifts in check", async () => {
    const wrapped = {
      undeclared: "delete" as const,
      entries: [{ name: "DEPLOY_REGION", value: "us-east-1" }],
    };
    const applyApi = new MockApi(listRoute(liveVariables)).allowMutations(
      "DELETE /repos/o/r/actions/variables/*",
    );
    const applied = await actionsVariablesSection.run(ctx(applyApi), wrapped);
    expect(applied.changes).toEqual(['DELETED undeclared Actions variable "RETIRED_FLAG"']);

    const checkApi = new MockApi(listRoute(liveVariables));
    const checked = await actionsVariablesSection.run(ctx(checkApi, true), wrapped);
    expect(checked.drift).toEqual([
      "actions_variables[RETIRED_FLAG]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(checkApi.mutations()).toEqual([]);
  });

  test("url-encodes tricky live names in the request path", async () => {
    const api = new MockApi(listRoute([{ name: "ODD NAME", value: "x" }])).allowMutations(
      "PATCH /repos/o/r/actions/variables/*",
    );
    await actionsVariablesSection.run(ctx(api), [{ name: "ODD NAME", value: "y" }]);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/actions/variables/ODD%20NAME");
  });

  test("the list request asks for the endpoint's 30-per-page cap", async () => {
    // The variables list caps per_page at 30; a 100 would be silently clamped
    // and a 30-item first page would wrongly end the walk. The second page
    // proves the loop continues past a FULL page of 30.
    const page1 = Array.from({ length: 30 }, (_, i) => ({ name: `VAR_${i}`, value: "x" }));
    const api = new MockApi({
      "GET /repos/o/r/actions/variables?per_page=30&page=1": {
        data: { total_count: 31, variables: page1 },
      },
      "GET /repos/o/r/actions/variables?per_page=30&page=2": {
        data: { total_count: 31, variables: [{ name: "VAR_30", value: "x" }] },
      },
    });
    const result = await actionsVariablesSection.run(
      ctx(api, true),
      page1.concat([{ name: "VAR_30", value: "x" }]),
    );
    expect(result.drift).toEqual([]);
    expect(api.calls.map((c) => c.path)).toEqual([
      "/repos/o/r/actions/variables?per_page=30&page=1",
      "/repos/o/r/actions/variables?per_page=30&page=2",
    ]);
  });
});

describe("actions_variables phantom keys", () => {
  test("apply notes keys the live variable does not carry before re-updating", async () => {
    const api = new MockApi(
      listRoute([{ name: "DEPLOY_REGION", value: "us-east-1" }]),
    ).allowMutations("PATCH /repos/o/r/actions/variables/*");
    const result = await actionsVariablesSection.run(ctx(api), [
      { name: "DEPLOY_REGION", value: "us-east-1", vaule: "typo" } as never,
    ]);
    expect(result.notes[0]).toMatch(
      /actions_variables\[DEPLOY_REGION\]: declared key\(s\) "vaule" do not exist on the live variable.*without converging/,
    );
    expect(result.changes).toEqual(['updated Actions variable "DEPLOY_REGION"']);
  });
});
