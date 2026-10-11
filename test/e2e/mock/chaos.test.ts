import { describe, expect, test } from "bun:test";
import { takeCorruption } from "./chaos.js";

describe("missing_envelope corruption", () => {
  test("a body key named __proto__ stays data in the stripped reply, as a seeded repo can spell it, and the lists still go", () => {
    // Parsed, not a literal: `__proto__` in an object literal sets the prototype.
    const body = JSON.parse('{"name": "svc", "topics": ["a"], "__proto__": {"example": true}}');
    const result = takeCorruption(
      "k",
      { corrupt: { key: "k", mode: "missing_envelope" }, corruptCounts: new Map() },
      { status: 200, body },
      { method: "GET", pathname: "/repos/octocat/svc", query: "", status: 0 },
    );
    const stripped = result?.response.body as Record<string, unknown>;
    expect({
      status: result?.response.status,
      offSpec: result?.offSpecBody,
      proto: Object.getPrototypeOf(stripped),
      keys: Object.getOwnPropertyNames(stripped),
      ownKey: Object.getOwnPropertyDescriptor(stripped, "__proto__")?.value,
      name: stripped.name,
    }).toEqual({
      status: 200,
      offSpec: true,
      proto: Object.prototype,
      keys: ["name", "__proto__"],
      ownKey: { example: true },
      name: "svc",
    });
  });
});
