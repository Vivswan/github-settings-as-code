import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import { checkSuitePreferencesSection } from "../../../src/sections/check_suite_preferences/index.js";
import type { SectionInput } from "../../../src/sections/contract/module.js";
import { planContext, type SectionPlan } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../mock-api.js";
import { provePlanIdempotent } from "../plan-idempotence.js";
import { REPO, unwrap } from "../section-run.js";
import { validatedInput } from "../validated-input.js";

describe("check_suite_preferences", () => {
  const path = "/repos/o/r/check-suites/preferences";
  const declared = {
    auto_trigger_checks: [
      { app_id: 15368, setting: false },
      { app_id: 29310, setting: true },
    ],
  };
  const note =
    "check_suite_preferences: GitHub exposes no read endpoint for check suite preferences, so check mode cannot verify them; apply re-asserts the declared preferences on every run";
  const plan = async (api: MockApi, desired: SectionInput<"check_suite_preferences">) =>
    unwrap(
      await checkSuitePreferencesSection.plan(
        planContext(checkSuitePreferencesSection, api, REPO),
        validatedInput("check_suite_preferences", desired),
      ),
    );
  /** The change line the plan's one operation renders for a PATCH response. */
  const rendered = (of: SectionPlan, response: unknown): string => {
    const change = of.ops[0]?.change;
    if (typeof change !== "function") {
      throw new Error("the plan carries no change thunk to render");
    }
    return String(unwrap(change(response)));
  };

  test("the plan is one driftless PATCH of the declared payload plus the cannot-verify note, and issues no request", async () => {
    // The fake would accept the PATCH; planning must not reach for it.
    const api = new MockApi({}).allowMutations(`PATCH ${path}`);
    const result = await plan(api, declared);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          payload: declared,
          describe: "setting check suite preferences",
          drift: [],
          change: expect.any(Function),
        },
      ],
      notes: [note],
      drift: [],
    });
    expect(api.calls).toEqual([]);
    // Three echoed entries against two declared can only come from GitHub's post-state, so the fallback cannot be what rendered it; a shapeless echo
    // falls back to the declared list.
    expect(
      rendered(result, {
        preferences: { auto_trigger_checks: [...declared.auto_trigger_checks, { app_id: 1 }] },
        repository: { full_name: "o/r" },
      }),
    ).toBe("applied check suite preferences (3 auto_trigger_checks entries)");
    expect(rendered(result, null)).toBe(
      "applied check suite preferences (2 auto_trigger_checks entries)",
    );
    const single = await plan(api, { auto_trigger_checks: [{ app_id: 15368, setting: true }] });
    expect(rendered(single, {})).toBe(
      "applied check suite preferences (1 auto_trigger_checks entry)",
    );
  });

  test("executing the plan PATCHes the payload verbatim, and the write recurs on every pass", async () => {
    const api = new MockApi({
      [`PATCH ${path}`]: {
        data: { preferences: declared, repository: { full_name: "o/r" } },
      },
    });
    const { first, second, changes, notes } = await provePlanIdempotent(
      checkSuitePreferencesSection,
      api,
      declared,
    );
    expect(changes).toEqual(["applied check suite preferences (2 auto_trigger_checks entries)"]);
    expect(notes).toEqual([]);
    expect(second.ops.map((op) => op.role)).toEqual(["update"]);
    expect(first.notes).toEqual([note]);
    expect(second.notes).toEqual([note]);
    // provePlanIdempotent executes the converged plan too, hence two PATCHes.
    expect(api.calls).toEqual([
      { method: "PATCH", path, payload: declared },
      { method: "PATCH", path, payload: declared },
    ]);
  });

  test("a denied PATCH names the Checks grant and the repo-admin caveat", async () => {
    const denied = new MockApi({
      [`PATCH ${path}`]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const planned = await plan(denied, declared);
    const execution = await executePlan(planned, checkSuitePreferencesSection, denied, REPO, {
      resolveSecret: () => {
        throw new Error("the section declares no secret values");
      },
    });
    expect(execution.status).toBe("failed");
    const message = execution.status === "failed" ? execution.failure.message : "";
    expect(message).toMatch(/"Checks" \(read and write\)/);
    expect(message).toMatch(/repository administrator/);
    expect(execution.landed).toBe(0);
  });
});
