import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { agentsVariablesSection, variableKey } from "./index.js";

describe("variableKey", () => {
  test("uppercases (GitHub stores variable names uppercased)", () => {
    expect(variableKey("agent_model")).toBe("AGENT_MODEL");
  });
});

/** The enveloped list body the mock serves for a live variable set. */
function listRoute(variables: Array<{ name: string; value: string }>) {
  return {
    "GET /repos/o/r/agents/variables?per_page=30&page=1": {
      data: { total_count: variables.length, variables },
    },
  };
}

describe("agents_variables", () => {
  const liveVariables = [
    { name: "AGENT_MODEL", value: "default" },
    { name: "RETIRED_FLAG", value: "off" },
  ];

  test("creates missing, updates drifted, deletes undeclared", async () => {
    const api = new MockApi(listRoute(liveVariables)).allowMutations(
      "POST /repos/o/r/agents/variables",
      "PATCH /repos/o/r/agents/variables/*",
      "DELETE /repos/o/r/agents/variables/*",
    );
    const result = await agentsVariablesSection.run(ctx(api), [
      { name: "AGENT_MODEL", value: "extended" },
      { name: "FIREWALL_MODE", value: "strict" },
    ]);
    expect(result.changes).toEqual([
      'updated Copilot agents variable "AGENT_MODEL"',
      'created Copilot agents variable "FIREWALL_MODE"',
      'DELETED undeclared Copilot agents variable "RETIRED_FLAG"',
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PATCH /repos/o/r/agents/variables/AGENT_MODEL",
      "POST /repos/o/r/agents/variables",
      "DELETE /repos/o/r/agents/variables/RETIRED_FLAG",
    ]);
    // The update sends the value only; the create sends name + value.
    expect(api.mutations()[0]?.payload).toEqual({ value: "extended" });
    expect(api.mutations()[1]?.payload).toEqual({ name: "FIREWALL_MODE", value: "strict" });
  });

  test("matches names case-insensitively: a lowercase declaration converges against the uppercase live name", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await agentsVariablesSection.run(ctx(api), [
      { name: "agent_model", value: "default" },
      { name: "Retired_Flag", value: "off" },
    ]);
    expect(result.changes).toEqual([]);
    // An apply-mode result has no drift list at all (the mode-split types).
    expect(result.drift).toBeUndefined();
    expect(api.mutations()).toEqual([]);
  });

  test("the update PATCHes the LIVE (uppercase) name even when declared lowercase", async () => {
    const api = new MockApi(listRoute(liveVariables)).allowMutations(
      "PATCH /repos/o/r/agents/variables/*",
      "DELETE /repos/o/r/agents/variables/*",
    );
    await agentsVariablesSection.run(ctx(api), [
      { name: "agent_model", value: "extended" },
      { name: "RETIRED_FLAG", value: "off" },
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PATCH /repos/o/r/agents/variables/AGENT_MODEL",
    ]);
  });

  test("two entries differing only in case are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      agentsVariablesSection.run(ctx(api), [
        { name: "agent_model", value: "a" },
        { name: "AGENT_MODEL", value: "b" },
      ]),
    ).rejects.toThrow(/same agents_variables entry/);
    expect(api.calls).toHaveLength(0);
  });

  test("check mode reports drift without mutating", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await agentsVariablesSection.run(ctx(api, true), [
      { name: "AGENT_MODEL", value: "extended" },
      { name: "FIREWALL_MODE", value: "strict" },
    ]);
    expect(result.drift).toEqual([
      'agents_variables[AGENT_MODEL].value: declared "extended" != live "default"; apply will set the declared value',
      "agents_variables[FIREWALL_MODE]: missing - declared in the settings file but not on the repo; apply will create it",
      "agents_variables[RETIRED_FLAG]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("wrapped undeclared:keep leaves the undeclared variable as a note, never a DELETE", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await agentsVariablesSection.run(ctx(api), {
      undeclared: "keep",
      entries: [{ name: "AGENT_MODEL", value: "default" }],
    });
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([
      'Copilot agents variable "RETIRED_FLAG" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("wrapped undeclared:keep in check mode notes the undeclared variable instead of drifting", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await agentsVariablesSection.run(ctx(api, true), {
      undeclared: "keep",
      entries: [{ name: "AGENT_MODEL", value: "default" }],
    });
    expect(result.drift).toEqual([]);
    expect(result.notes).toHaveLength(1);
  });

  test("the wrapper without a policy keeps the delete default", async () => {
    const api = new MockApi(listRoute(liveVariables)).allowMutations(
      "DELETE /repos/o/r/agents/variables/*",
    );
    const result = await agentsVariablesSection.run(ctx(api), {
      entries: [{ name: "AGENT_MODEL", value: "default" }],
    });
    expect(result.changes).toEqual(['DELETED undeclared Copilot agents variable "RETIRED_FLAG"']);
  });

  test("an explicit undeclared:delete deletes in apply and drifts in check", async () => {
    const wrapped = {
      undeclared: "delete" as const,
      entries: [{ name: "AGENT_MODEL", value: "default" }],
    };
    const applyApi = new MockApi(listRoute(liveVariables)).allowMutations(
      "DELETE /repos/o/r/agents/variables/*",
    );
    const applied = await agentsVariablesSection.run(ctx(applyApi), wrapped);
    expect(applied.changes).toEqual(['DELETED undeclared Copilot agents variable "RETIRED_FLAG"']);

    const checkApi = new MockApi(listRoute(liveVariables));
    const checked = await agentsVariablesSection.run(ctx(checkApi, true), wrapped);
    expect(checked.drift).toEqual([
      "agents_variables[RETIRED_FLAG]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
    ]);
    expect(checkApi.mutations()).toEqual([]);
  });

  test("url-encodes tricky live names in the request path", async () => {
    const api = new MockApi(listRoute([{ name: "ODD NAME", value: "x" }])).allowMutations(
      "PATCH /repos/o/r/agents/variables/*",
    );
    await agentsVariablesSection.run(ctx(api), [{ name: "ODD NAME", value: "y" }]);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/agents/variables/ODD%20NAME");
  });

  test("the list request asks for the endpoint's 30-per-page cap", async () => {
    // The variables list caps per_page at 30; a 100 would be silently clamped
    // and a 30-item first page would wrongly end the walk. The second page
    // proves the loop continues past a FULL page of 30.
    const page1 = Array.from({ length: 30 }, (_, i) => ({ name: `VAR_${i}`, value: "x" }));
    const api = new MockApi({
      "GET /repos/o/r/agents/variables?per_page=30&page=1": {
        data: { total_count: 31, variables: page1 },
      },
      "GET /repos/o/r/agents/variables?per_page=30&page=2": {
        data: { total_count: 31, variables: [{ name: "VAR_30", value: "x" }] },
      },
    });
    const result = await agentsVariablesSection.run(
      ctx(api, true),
      page1.concat([{ name: "VAR_30", value: "x" }]),
    );
    expect(result.drift).toEqual([]);
    expect(api.calls.map((c) => c.path)).toEqual([
      "/repos/o/r/agents/variables?per_page=30&page=1",
      "/repos/o/r/agents/variables?per_page=30&page=2",
    ]);
  });
});

describe("agents_variables phantom keys", () => {
  test("apply notes keys the live variable does not carry before re-updating", async () => {
    const api = new MockApi(listRoute([{ name: "AGENT_MODEL", value: "default" }])).allowMutations(
      "PATCH /repos/o/r/agents/variables/*",
    );
    const result = await agentsVariablesSection.run(ctx(api), [
      { name: "AGENT_MODEL", value: "default", vaule: "typo" } as never,
    ]);
    expect(result.notes[0]).toMatch(
      /agents_variables\[AGENT_MODEL\]: declared key\(s\) "vaule" do not exist on the live variable.*without converging/,
    );
    expect(result.changes).toEqual(['updated Copilot agents variable "AGENT_MODEL"']);
  });
});
