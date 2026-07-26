import { describe, expect, test } from "bun:test";
import { PermissionDenied } from "../../src/sections/contract.js";
import { interactionLimitsSection } from "../../src/sections/interaction-limits.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

const GET = "GET /repos/o/r/interaction-limits";
const LIVE = { limit: "existing_users", origin: "repository", expires_at: "2026-01-02T00:00:00Z" };

describe("interaction_limits", () => {
  test("check drifts when no live limit exists (never set, or expired)", async () => {
    const api = new MockApi({ [GET]: { data: {} } });
    const result = await interactionLimitsSection.run(ctx(api, true), {
      limit: "contributors_only",
    });
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("no live limit");
    expect(api.mutations()).toEqual([]);
  });

  test("check diffs the limit value but never the write-only expiry", async () => {
    const api = new MockApi({ [GET]: { data: LIVE } });
    const result = await interactionLimitsSection.run(ctx(api, true), {
      limit: "contributors_only",
      expiry: "one_week",
    });
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("interaction_limits.limit");
    expect(result.drift.join(" ")).not.toContain("expiry");
    // The declared expiry produces the cannot-verify note instead.
    expect(result.notes.some((n) => n.includes("expiry"))).toBe(true);
  });

  test("a matching live limit is clean apart from the expiry note", async () => {
    const api = new MockApi({ [GET]: { data: LIVE } });
    const result = await interactionLimitsSection.run(ctx(api, true), {
      limit: "existing_users",
      expiry: "one_day",
    });
    expect(result.drift).toEqual([]);
  });

  test("an org-origin live limit adds the override note", async () => {
    const api = new MockApi({ [GET]: { data: { ...LIVE, origin: "organization" } } });
    const result = await interactionLimitsSection.run(ctx(api, true), {
      limit: "existing_users",
    });
    expect(result.notes.some((n) => n.includes("overrides this repository's"))).toBe(true);
  });

  test("declared != org-set live limit is drift (with the cannot-fix note), not clean", async () => {
    const api = new MockApi({ [GET]: { data: { ...LIVE, origin: "organization" } } });
    const result = await interactionLimitsSection.run(ctx(api, true), {
      limit: "collaborators_only",
    });
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("interaction_limits.limit");
    expect(result.notes.some((n) => n.includes("apply cannot change it"))).toBe(true);
  });

  test("declared null against an org-set live limit is drift that says apply cannot remove it", async () => {
    const api = new MockApi({ [GET]: { data: { ...LIVE, origin: "organization" } } });
    const result = await interactionLimitsSection.run(ctx(api, true), null);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("apply cannot remove it");
  });

  test("declared null: clean when live is empty, drift when a repo limit is live", async () => {
    const clean = await interactionLimitsSection.run(
      ctx(new MockApi({ [GET]: { data: {} } }), true),
      null,
    );
    expect(clean.drift).toEqual([]);
    const api = new MockApi({ [GET]: { data: LIVE } });
    const drifted = await interactionLimitsSection.run(ctx(api, true), null);
    expect(drifted.drift).toHaveLength(1);
    expect(drifted.drift[0]).toContain("apply will remove it");
    expect(api.mutations()).toEqual([]);
  });

  test("apply PUTs the declared object verbatim and re-arms every run", async () => {
    const api = new MockApi({}).allowMutations("PUT /repos/o/r/interaction-limits");
    const result = await interactionLimitsSection.run(ctx(api), {
      limit: "collaborators_only",
      expiry: "one_week",
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "PUT /repos/o/r/interaction-limits",
    ]);
    expect(api.mutations()[0]?.payload).toEqual({
      limit: "collaborators_only",
      expiry: "one_week",
    });
    expect(result.changes).toEqual([
      'armed the "collaborators_only" interaction limit (expiry: one_week)',
    ]);
  });

  test("apply with null clears via DELETE", async () => {
    const api = new MockApi({}).allowMutations("DELETE /repos/o/r/interaction-limits");
    const result = await interactionLimitsSection.run(ctx(api), null);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/interaction-limits",
    ]);
    expect(result.changes).toEqual(["cleared the interaction limit"]);
  });

  test("a 409 on the write becomes a note, not a failure", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/interaction-limits": {
        error: { status: 409, message: "Conflict", body: "" },
      },
    });
    const result = await interactionLimitsSection.run(ctx(api), { limit: "existing_users" });
    expect(result.changes).toEqual([]);
    expect(result.notes.some((n) => n.includes("was not applied (409)"))).toBe(true);
  });

  test("a 409 on the clear (null) likewise becomes a note", async () => {
    const api = new MockApi({
      "DELETE /repos/o/r/interaction-limits": {
        error: { status: 409, message: "Conflict", body: "" },
      },
    });
    const result = await interactionLimitsSection.run(ctx(api), null);
    expect(result.changes).toEqual([]);
    expect(result.notes.some((n) => n.includes("clear was not applied (409)"))).toBe(true);
  });

  test("a denied GET classifies as PermissionDenied", async () => {
    const api = new MockApi({
      [GET]: { error: { status: 404, message: "Not Found", body: "" } },
    });
    await expect(
      interactionLimitsSection.run(ctx(api, true), { limit: "existing_users" }),
    ).rejects.toBeInstanceOf(PermissionDenied);
  });
});
