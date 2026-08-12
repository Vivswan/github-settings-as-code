import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { checkSuitePreferencesSection } from "./index.js";

describe("check_suite_preferences", () => {
  const path = "/repos/o/r/check-suites/preferences";
  const declared = {
    auto_trigger_checks: [
      { app_id: 15368, setting: false },
      { app_id: 29310, setting: true },
    ],
  };

  test("check mode issues NO request and emits exactly one cannot-verify note", async () => {
    const api = new MockApi({});
    const result = await checkSuitePreferencesSection.run(ctx(api, true), declared);
    expect(api.calls).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("no read endpoint");
    expect(result.notes[0]).toContain("re-asserts");
  });

  test("apply PATCHes the declared payload verbatim, counting the echoed entries", async () => {
    const api = new MockApi({
      [`PATCH ${path}`]: {
        data: { preferences: declared, repository: { full_name: "o/r" } },
      },
    });
    const result = await checkSuitePreferencesSection.run(ctx(api), declared);
    expect(api.calls).toEqual([{ method: "PATCH", path, payload: declared }]);
    expect(result.changes).toEqual([
      "applied check suite preferences (2 auto_trigger_checks entries)",
    ]);
  });

  test("a shapeless echo falls back to the declared list for the change line", async () => {
    const api = new MockApi({}).allowMutations(`PATCH ${path}`);
    const result = await checkSuitePreferencesSection.run(ctx(api), {
      auto_trigger_checks: [{ app_id: 15368, setting: true }],
    });
    expect(result.changes).toEqual([
      "applied check suite preferences (1 auto_trigger_checks entry)",
    ]);
  });

  test("a denied PATCH names the Checks grant and the repo-admin caveat", async () => {
    const denied = new MockApi({
      [`PATCH ${path}`]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const error = (await checkSuitePreferencesSection
      .run(ctx(denied), declared)
      .then(() => null)
      .catch((thrown) => thrown)) as Error;
    expect(error).not.toBeNull();
    expect(error.message).toMatch(/"Checks" \(read and write\)/);
    expect(error.message).toMatch(/repository administrator/);
  });
});
