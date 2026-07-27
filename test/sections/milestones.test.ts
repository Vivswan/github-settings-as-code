import { describe, expect, test } from "bun:test";
import { milestonesSection } from "../../src/sections/milestones.js";
import { MockApi } from "../mock-api.js";
import { ctx } from "./context.js";

describe("milestones undeclared policy", () => {
  const liveMilestones = [
    { number: 1, title: "v1", description: null, state: "open" },
    { number: 2, title: "old", description: null, state: "open" },
  ];

  test("the keep default leaves the undeclared milestone as a note", async () => {
    const api = new MockApi({
      "GET /repos/o/r/milestones?state=all&per_page=100&page=1": { data: liveMilestones },
    });
    const result = await milestonesSection.run(ctx(api), [{ title: "v1" }]);
    expect(result.changes).toEqual([]);
    expect(result.notes).toEqual([
      'milestone "old" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it, detaching it from every issue that carries it (closing is not enough; closed milestones are still listed)',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("wrapped undeclared:delete DELETES the undeclared milestone and names the detach consequence", async () => {
    const api = new MockApi({
      "GET /repos/o/r/milestones?state=all&per_page=100&page=1": { data: liveMilestones },
    }).allowMutations("DELETE /repos/o/r/milestones/*");
    const result = await milestonesSection.run(ctx(api), {
      undeclared: "delete",
      entries: [{ title: "v1" }],
    });
    expect(result.changes).toEqual([
      'DELETED undeclared milestone "old" (detached from every issue that carried it)',
    ]);
    expect(api.mutations().map((m) => `${m.method} ${m.path}`)).toEqual([
      "DELETE /repos/o/r/milestones/2",
    ]);
  });

  test("wrapped undeclared:delete in check mode reports drift naming the detach consequence", async () => {
    const api = new MockApi({
      "GET /repos/o/r/milestones?state=all&per_page=100&page=1": { data: liveMilestones },
    });
    const result = await milestonesSection.run(ctx(api, true), {
      undeclared: "delete",
      entries: [{ title: "v1" }],
    });
    expect(result.drift).toEqual([
      'milestones[old]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it, detaching it from every issue that carries it; add it to the settings file to keep it',
    ]);
    expect(api.mutations()).toEqual([]);
  });

  test("the wrapper without a policy keeps the keep default", async () => {
    const api = new MockApi({
      "GET /repos/o/r/milestones?state=all&per_page=100&page=1": { data: liveMilestones },
    });
    const result = await milestonesSection.run(ctx(api), { entries: [{ title: "v1" }] });
    expect(result.changes).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(api.mutations()).toEqual([]);
  });
});
