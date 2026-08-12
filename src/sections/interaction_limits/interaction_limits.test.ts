import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { PermissionDenied } from "../contract.js";
import { interactionLimitsSection } from "./index.js";

const GET = "GET /repos/o/r/interaction-limits";
const CAP_GET = "GET /repos/o/r/interaction-limits/pulls/creation-cap";
const CAP_PATCH = "PATCH /repos/o/r/interaction-limits/pulls/creation-cap";
const BYPASS_GET = "GET /repos/o/r/interaction-limits/pulls/bypass-list";
const BYPASS_PUT = "PUT /repos/o/r/interaction-limits/pulls/bypass-list";
const BYPASS_DELETE = "DELETE /repos/o/r/interaction-limits/pulls/bypass-list";
const LIVE = { limit: "existing_users", origin: "repository", expires_at: "2026-01-02T00:00:00Z" };
const CAP_LIVE = { enabled: false, max_open_pull_requests: 1 };
const CAP_405 = { error: { status: 405, message: "Method Not Allowed", body: "" } } as const;

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

describe("interaction_limits pull request creation cap", () => {
  test("check diffs the declared cap exactly against the live one", async () => {
    const api = new MockApi({ [CAP_GET]: { data: CAP_LIVE } });
    const result = await interactionLimitsSection.run(ctx(api, true), {
      pull_request_creation_cap: { enabled: true, max_open_pull_requests: 5 },
    });
    expect(result.drift.some((d) => d.includes("pull_request_creation_cap.enabled"))).toBe(true);
    expect(
      result.drift.some((d) => d.includes("pull_request_creation_cap.max_open_pull_requests")),
    ).toBe(true);
    // No base key is declared, so the base-limit GET never runs.
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([CAP_GET]);
  });

  test("check reports a 405 (cap unavailable) as honest drift, never clean", async () => {
    const api = new MockApi({ [CAP_GET]: CAP_405 });
    const result = await interactionLimitsSection.run(ctx(api, true), {
      pull_request_creation_cap: { enabled: true },
    });
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("not available on this repository");
    expect(api.mutations()).toEqual([]);
  });

  test("apply PATCHes only on divergence", async () => {
    const api = new MockApi({ [CAP_GET]: { data: CAP_LIVE } }).allowMutations(CAP_PATCH);
    const result = await interactionLimitsSection.run(ctx(api), {
      pull_request_creation_cap: { enabled: true, max_open_pull_requests: 5 },
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([CAP_PATCH]);
    expect(api.mutations()[0]?.payload).toEqual({ enabled: true, max_open_pull_requests: 5 });
    expect(result.changes).toEqual([
      "set the pull request creation cap (enabled: true, max_open_pull_requests: 5)",
    ]);
  });

  test("apply notes a declared cap key absent from the live cap (phantom key)", async () => {
    const api = new MockApi({ [CAP_GET]: { data: CAP_LIVE } }).allowMutations(CAP_PATCH);
    const result = await interactionLimitsSection.run(ctx(api), {
      pull_request_creation_cap: { enabled: true, max_open_prs: 5 },
    });
    expect(result.notes.some((n) => n.includes('"max_open_prs"'))).toBe(true);
    expect(result.notes.some((n) => n.includes("this PATCH will re-run"))).toBe(true);
  });

  test("apply skips the PATCH when the live cap already matches (no re-arm)", async () => {
    const api = new MockApi({
      [CAP_GET]: { data: { enabled: true, max_open_pull_requests: 5 } },
    });
    const result = await interactionLimitsSection.run(ctx(api), {
      pull_request_creation_cap: { enabled: true, max_open_pull_requests: 5 },
    });
    expect(api.mutations()).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  test("apply turns a 405 into a note, not a failure", async () => {
    const api = new MockApi({ [CAP_GET]: CAP_405 });
    const result = await interactionLimitsSection.run(ctx(api), {
      pull_request_creation_cap: { enabled: true },
    });
    expect(api.mutations()).toEqual([]);
    expect(result.notes.some((n) => n.includes("was not applied (405)"))).toBe(true);
  });

  test("a tolerated base 409 no longer short-circuits the declared cap", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/interaction-limits": {
        error: { status: 409, message: "Conflict", body: "" },
      },
      [CAP_GET]: { data: CAP_LIVE },
    }).allowMutations(CAP_PATCH);
    const result = await interactionLimitsSection.run(ctx(api), {
      limit: "existing_users",
      pull_request_creation_cap: { enabled: true },
    });
    expect(result.notes.some((n) => n.includes("was not applied (409)"))).toBe(true);
    expect(result.changes).toEqual(["set the pull request creation cap (enabled: true)"]);
  });
});

describe("interaction_limits pull request creation bypass list", () => {
  const liveUsers = [{ login: "keeper" }, { login: "goner" }];

  test("check reports the undeclared and missing logins as drift", async () => {
    const api = new MockApi({ [BYPASS_GET]: { data: liveUsers } });
    const result = await interactionLimitsSection.run(ctx(api, true), {
      pull_request_creation_bypass: ["Keeper", "newcomer"],
    });
    expect(result.drift).toHaveLength(2);
    expect(result.drift[0]).toContain("[goner]");
    expect(result.drift[1]).toContain("[newcomer]");
    expect(api.mutations()).toEqual([]);
  });

  test("apply DELETEs only the undeclared logins, then PUTs only the missing ones", async () => {
    const api = new MockApi({ [BYPASS_GET]: { data: liveUsers } }).allowMutations(
      BYPASS_PUT,
      BYPASS_DELETE,
    );
    const result = await interactionLimitsSection.run(ctx(api), {
      pull_request_creation_bypass: ["Keeper", "newcomer"],
    });
    // Removal first: the list holds at most 100 users, so adding before
    // removing could transiently overflow it.
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      BYPASS_DELETE,
      BYPASS_PUT,
    ]);
    // "Keeper" matches the live "keeper" case-insensitively: neither written.
    expect(api.mutations()[0]?.payload).toEqual({ users: ["goner"] });
    expect(api.mutations()[1]?.payload).toEqual({ users: ["newcomer"] });
    expect(result.changes).toEqual([
      "removed [goner] from the pull request creation cap bypass list",
      "added [newcomer] to the pull request creation cap bypass list",
    ]);
  });

  test("a matching live list (case-insensitively) is a no-op", async () => {
    const api = new MockApi({ [BYPASS_GET]: { data: liveUsers } });
    const result = await interactionLimitsSection.run(ctx(api), {
      pull_request_creation_bypass: ["KEEPER", "Goner"],
    });
    expect(api.mutations()).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  test("a declared empty list removes everyone", async () => {
    const api = new MockApi({ [BYPASS_GET]: { data: liveUsers } }).allowMutations(BYPASS_DELETE);
    const result = await interactionLimitsSection.run(ctx(api), {
      pull_request_creation_bypass: [],
    });
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([BYPASS_DELETE]);
    expect(api.mutations()[0]?.payload).toEqual({ users: ["keeper", "goner"] });
    expect(result.changes).toEqual([
      "removed [keeper, goner] from the pull request creation cap bypass list",
    ]);
  });

  test("null clears the base limit only and never touches the cap or bypass list", async () => {
    const api = new MockApi({}).allowMutations("DELETE /repos/o/r/interaction-limits");
    await interactionLimitsSection.run(ctx(api), null);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /repos/o/r/interaction-limits",
    ]);
  });
});

describe("interaction_limits shape", () => {
  const shape = interactionLimitsSection.shape;

  test("an object declaring none of the three groups is rejected upfront", () => {
    const parsed = shape.safeParse({});
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("declare at least one of");
  });

  test("a base key without limit is rejected (it would ride a PUT that never fires)", () => {
    const parsed = shape.safeParse({
      expiry: "one_week",
      pull_request_creation_cap: { enabled: true },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("requires a limit");
  });

  test("a bypass list over GitHub's 100-user cap is rejected", () => {
    const parsed = shape.safeParse({
      pull_request_creation_bypass: Array.from({ length: 101 }, (_, i) => `user-${i}`),
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("caps the bypass list at 100");
  });

  test("two case-variant spellings of one login are rejected as duplicates", () => {
    const parsed = shape.safeParse({ pull_request_creation_bypass: ["octocat", "Octocat"] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("name the same login");
  });

  test('a YAML-quoted "true" cap flag fails with the boolean-gotcha message', () => {
    const parsed = shape.safeParse({ pull_request_creation_cap: { enabled: "true" } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("unquoted true or false");
  });

  test("the three groups each stand alone, and null still parses", () => {
    expect(shape.safeParse({ limit: "existing_users" }).success).toBe(true);
    expect(shape.safeParse({ pull_request_creation_cap: { enabled: false } }).success).toBe(true);
    expect(shape.safeParse({ pull_request_creation_bypass: [] }).success).toBe(true);
    expect(shape.safeParse(null).success).toBe(true);
  });
});
