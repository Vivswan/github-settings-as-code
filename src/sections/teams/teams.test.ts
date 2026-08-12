import { describe, expect, test } from "bun:test";
import { MockApi } from "../../../test/mock-api.js";
import { ctx } from "../../../test/sections/context.js";
import { teamsSection } from "./index.js";

describe("teams", () => {
  test("a personal account no-ops with a note instead of failing", async () => {
    const api = new MockApi({});
    const result = await teamsSection.run(ctx(api), [{ name: "platform", permission: "push" }]);
    expect(result.notes[0]).toContain("personal account");
    expect(api.mutations()).toEqual([]);
  });
});
