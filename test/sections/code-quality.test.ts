import { describe, expect, test } from "bun:test";
import { codeQualitySetupSection } from "../../src/sections/code-quality.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("code_quality_setup", () => {
  const path = "/repos/o/r/code-quality/setup";
  const live = {
    state: "configured",
    languages: ["javascript-typescript", "python"],
    runner_type: "standard",
  };

  test("check compares declared keys only, languages as a set", async () => {
    const api = new MockApi({ [`GET ${path}`]: { data: live } });
    const drifted = await codeQualitySetupSection.run(ctx(api, true), {
      state: "configured",
      ai_findings_option: "on_push",
    });
    expect(drifted.drift).toHaveLength(1);
    expect(drifted.drift[0]).toContain("ai_findings_option");
    const reordered = await codeQualitySetupSection.run(ctx(api, true), {
      languages: ["python", "javascript-typescript"],
    });
    expect(reordered.drift).toEqual([]);
    expect(api.mutations()).toEqual([]);
  });

  test("apply PATCHes the declared payload verbatim", async () => {
    const api = new MockApi({}).allowMutations(`PATCH ${path}`);
    const result = await codeQualitySetupSection.run(ctx(api), {
      state: "configured",
      ai_findings_option: "disabled",
    });
    expect(result.changes).toEqual(["applied code quality setup"]);
    expect(api.mutations()).toEqual([
      {
        method: "PATCH",
        path,
        payload: { state: "configured", ai_findings_option: "disabled" },
      },
    ]);
  });

  test("a 202 configuration run is named in the change line", async () => {
    const api = new MockApi({
      [`PATCH ${path}`]: { data: { run_id: 42, run_url: "https://example.test/runs/42" } },
    });
    const result = await codeQualitySetupSection.run(ctx(api), { state: "configured" });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("configuration run 42");
  });

  test("409 gets wait-and-retry advice; 403 mentions code quality availability", async () => {
    const busy = new MockApi({
      [`PATCH ${path}`]: { error: { status: 409, message: "Conflict", body: "" } },
    });
    await expect(codeQualitySetupSection.run(ctx(busy), { state: "configured" })).rejects.toThrow(
      /already in progress/,
    );
    const denied = new MockApi({
      [`PATCH ${path}`]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    await expect(codeQualitySetupSection.run(ctx(denied), { state: "configured" })).rejects.toThrow(
      /code quality is unavailable/,
    );
  });
});
