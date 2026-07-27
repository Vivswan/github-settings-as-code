import { describe, expect, test } from "bun:test";
import { branchesSection } from "../../src/sections/branches.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("branches", () => {
  const declared = [{ name: "main", protection: { enforce_admins: true } }];

  test("check: existing unprotected branch reports protectable drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main": { data: { name: "main" } },
    });
    const result = await branchesSection.run(ctx(api, true), declared);
    expect(result.drift).toEqual([
      "branches[main]: unprotected live but the settings file declares protection; apply will protect it",
    ]);
  });

  test("check: missing branch is reported as nonexistent, not unprotected", async () => {
    const api = new MockApi({}); // every GET 404s, including the branch itself
    const result = await branchesSection.run(ctx(api, true), declared);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("does not exist");
  });

  test("check: inconclusive branch probe falls back to unprotected drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main": { error: { status: 403, message: "Forbidden", body: "" } },
    });
    const result = await branchesSection.run(ctx(api, true), declared);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toContain("apply will protect it");
  });

  test("duplicate branch names are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(
      branchesSection.run(ctx(api), [
        { name: "main", protection: { enforce_admins: true } },
        { name: "main", protection: null },
      ]),
    ).rejects.toThrow(/same branches entry/);
    expect(api.calls).toHaveLength(0);
  });

  const SIG_PATH = "/repos/o/r/branches/main/protection/required_signatures";

  test("apply: required_signatures true POSTs the sub-endpoint after the PUT", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/branches/main/protection": { data: {} },
      [`POST ${SIG_PATH}`]: { data: { enabled: true } },
    });
    await branchesSection.run(ctx(api), [
      { name: "main", protection: { enforce_admins: true, required_signatures: true } },
    ]);
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /repos/o/r/branches/main/protection",
      `POST ${SIG_PATH}`,
    ]);
    // The PUT body must not carry the key GitHub would silently drop.
    const put = api.mutations()[0];
    expect(Object.keys(put?.payload as Record<string, unknown>)).not.toContain(
      "required_signatures",
    );
  });

  test("apply: required_signatures false DELETEs the sub-endpoint after the PUT", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/branches/main/protection": { data: {} },
      [`DELETE ${SIG_PATH}`]: { data: null },
    });
    await branchesSection.run(ctx(api), [
      { name: "main", protection: { enforce_admins: true, required_signatures: false } },
    ]);
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /repos/o/r/branches/main/protection",
      `DELETE ${SIG_PATH}`,
    ]);
  });

  test("apply: undeclared required_signatures touches the sub-endpoint in neither direction", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/branches/main/protection": { data: {} },
    });
    await branchesSection.run(ctx(api), declared);
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /repos/o/r/branches/main/protection",
    ]);
  });

  test("apply: protection null removes protection without touching the sub-endpoint", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main/protection": {
        data: { enforce_admins: { enabled: true }, required_signatures: { enabled: true } },
      },
      "DELETE /repos/o/r/branches/main/protection": { data: null },
    });
    await branchesSection.run(ctx(api), [{ name: "main", protection: null }]);
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /repos/o/r/branches/main/protection",
    ]);
  });

  test("check: declared true against live {enabled: true} is clean", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main/protection": {
        data: { enforce_admins: { enabled: true }, required_signatures: { enabled: true } },
      },
    });
    const result = await branchesSection.run(ctx(api, true), [
      { name: "main", protection: { enforce_admins: true, required_signatures: true } },
    ]);
    expect(result.drift).toEqual([]);
  });

  test("check: declared false against live {enabled: false} is clean", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main/protection": {
        data: { enforce_admins: { enabled: true }, required_signatures: { enabled: false } },
      },
    });
    const result = await branchesSection.run(ctx(api, true), [
      { name: "main", protection: { enforce_admins: true, required_signatures: false } },
    ]);
    expect(result.drift).toEqual([]);
  });

  test("check: declared false against an ABSENT live field is clean (absent means false)", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main/protection": {
        data: { enforce_admins: { enabled: true } },
      },
    });
    const result = await branchesSection.run(ctx(api, true), [
      { name: "main", protection: { enforce_admins: true, required_signatures: false } },
    ]);
    expect(result.drift).toEqual([]);
  });

  test("check: declared true against an ABSENT live field is drift", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main/protection": {
        data: { enforce_admins: { enabled: true } },
      },
    });
    const result = await branchesSection.run(ctx(api, true), [
      { name: "main", protection: { enforce_admins: true, required_signatures: true } },
    ]);
    expect(result.drift).toEqual(["branches[main].protection.required_signatures: true != false"]);
  });

  test('a quoted "true" fails the shape upfront, with the YAML gotcha named', () => {
    // The toggle is typed in the zod shape so document validation rejects it
    // before ANY section writes - not a run()-time throw after earlier
    // sections already applied.
    const parsed = branchesSection.shape.safeParse([
      { name: "main", protection: { enforce_admins: true, required_signatures: "true" } },
    ]);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    expect(messages.some((m) => m.includes("unquoted true or false"))).toBe(true);
    // The passthrough survives the typed key: unknown protection fields and
    // a proper boolean both validate.
    expect(
      branchesSection.shape.safeParse([
        {
          name: "main",
          protection: { enforce_admins: true, required_signatures: true, future_field: "x" },
        },
        { name: "legacy", protection: null },
      ]).success,
    ).toBe(true);
  });
});
