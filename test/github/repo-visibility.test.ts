import { describe, expect, test } from "bun:test";
import { createVisibilityResolver, type RepoVisibility } from "../../src/github/repo-visibility.js";
import { MockApi, type Route } from "../mock-api.js";

describe("createVisibilityResolver", () => {
  // Fails closed for the redaction decision: unknown, never public, whenever the body proves neither.
  const answers: Array<[name: string, expected: RepoVisibility, route: Route]> = [
    ["visibility: public", "public", { data: { visibility: "public" } }],
    ["visibility: private", "private", { data: { visibility: "private" } }],
    ["visibility: internal", "internal", { data: { visibility: "internal" } }],
    ["private: true with no visibility field", "private", { data: { private: true } }],
    ["private: false with no visibility field", "public", { data: { private: false } }],
    [
      "private: true beside a stale/forged visibility: public",
      "private",
      { data: { visibility: "public", private: true } },
    ],
    [
      "private: true beside visibility: internal",
      "internal",
      { data: { visibility: "internal", private: true } },
    ],
    [
      "a probe error",
      "unknown",
      { error: { status: 403, message: "Resource not accessible", body: "" } },
    ],
    ["a 200 body with neither visibility nor private", "unknown", { data: { full_name: "o/r" } }],
    ["a string 'false' private flag", "unknown", { data: { private: "false" } }],
    ["a numeric 0 private flag", "unknown", { data: { private: 0 } }],
    ["an out-of-enum visibility string", "unknown", { data: { visibility: "PUBLIC" } }],
  ];
  test.each(answers)("%s resolves to %s", async (_name, expected, route) => {
    const api = new MockApi({ "GET /repos/o/r": route });
    expect(await createVisibilityResolver(api)("o/r")).toBe(expected);
  });

  test("one probe per repository, case-insensitively, errors included", async () => {
    const api = new MockApi({
      "GET /repos/o/pub": { data: { visibility: "public" } },
      "GET /repos/o/gone": { error: { status: 404, message: "Not Found", body: "" } },
    });
    const resolve = createVisibilityResolver(api);
    expect(await resolve("o/pub")).toBe("public");
    expect(await resolve("O/Pub")).toBe("public");
    expect(await resolve("o/gone")).toBe("unknown");
    expect(await resolve("o/gone")).toBe("unknown");
    expect(api.calls.map((call) => call.path)).toEqual(["/repos/o/pub", "/repos/o/gone"]);
  });
});
