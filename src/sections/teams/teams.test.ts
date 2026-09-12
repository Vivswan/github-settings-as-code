import { describe, expect, test } from "bun:test";
import { planContext } from "../../../src/sections/contract/plan.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO } from "../../../test/sections/section-run.js";
import { teamsSection } from "./index.js";
import { teamsMockHandlers } from "./mock.js";

const ORG = "GET /orgs/o";
const LIST = "GET /repos/o/r/teams?per_page=100&page=1";
const probeOf = (slug: string) => `GET /orgs/o/teams/${slug}/repos/o/r`;
const plan = (api: MockApi, desired: Parameters<typeof teamsSection.plan>[1]) =>
  teamsSection.plan(planContext(teamsSection, api, REPO), desired);
const snapshot = (api: MockApi) => teamsSection.snapshot(planContext(teamsSection, api, REPO));

describe("teams", () => {
  test("a personal account no-ops with a note after the org probe alone", async () => {
    const api = new MockApi({});
    const result = await plan(api, [{ name: "platform", permission: "push" }]);
    expect(result).toEqual({
      ops: [],
      notes: [
        'teams: owner "o" is a personal account, not an organization, so team access does not apply; section skipped - remove the teams section from the settings file to silence this note',
      ],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([ORG]);
  });

  test("plans a grant per team without access or at a divergent role, and nothing for a converged one", async () => {
    const api = new MockApi({
      [ORG]: { data: { login: "o" } },
      [probeOf("platform")]: { data: { role_name: "read" } },
      [probeOf("ops")]: { data: { role_name: "write" } },
    });
    const result = await plan(api, [
      { name: "platform", permission: "push" },
      { name: "ops" },
      { name: "new", permission: "admin" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "grant",
          params: { org: "o", team_slug: "platform" },
          payload: { permission: "push" },
          describe: 'granting team "platform" access',
          drift: [
            'teams[platform]: live role "read" != declared "write"; apply will set the declared permission',
          ],
          change: 'granted team "platform" push',
        },
        {
          role: "grant",
          params: { org: "o", team_slug: "new" },
          payload: { permission: "admin" },
          describe: 'granting team "new" access',
          drift: ['teams[new]: no access to o/r; apply will grant "admin"'],
          change: 'granted team "new" admin',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      ORG,
      probeOf("platform"),
      probeOf("ops"),
      probeOf("new"),
    ]);
  });

  test("a bare 204 probe body reads as access without a role, so the declared role is drift", async () => {
    const api = new MockApi({
      [ORG]: { data: { login: "o" } },
      [probeOf("platform")]: { data: null },
    });
    const result = await plan(api, [{ name: "platform", permission: "pull" }]);
    expect(result.ops.map((op) => op.drift)).toEqual([
      ['teams[platform]: live role "" != declared "read"; apply will set the declared permission'],
    ]);
  });

  test("only a 404 on the org probe reads as a personal account; a 403 fails the section", async () => {
    const api = new MockApi({
      [ORG]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    await expect(plan(api, [{ name: "platform" }])).rejects.toThrow(/403/);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([ORG]);
  });

  test("two entries naming the same slug are rejected before any API call", async () => {
    const api = new MockApi({});
    await expect(plan(api, [{ name: "ops" }, { name: "Ops", permission: "pull" }])).rejects.toThrow(
      /same teams entry: "ops" and "Ops"/,
    );
    expect(api.calls).toHaveLength(0);
  });

  test("executing the plan against the mock fragment converges: the re-plan is empty", async () => {
    const api = fragmentFake(teamsSection, teamsMockHandlers, {
      teams: { platform: { role_name: "read" }, ops: { role_name: "write" } },
    });
    const { second, changes } = await provePlanIdempotent(teamsSection, api, [
      { name: "platform", permission: "push" },
      { name: "ops", permission: "push" },
      { name: "new", permission: "admin" },
    ]);
    expect(changes).toEqual(['granted team "platform" push', 'granted team "new" admin']);
    expect(api.writes).toEqual([
      "PUT /orgs/o/teams/platform/repos/o/r",
      "PUT /orgs/o/teams/new/repos/o/r",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.state.teams).toEqual({
      platform: { role_name: "write" },
      ops: { role_name: "write" },
      new: { role_name: "admin" },
    });
  });

  test("the read port exposes the org probe in its absent posture, the list, and the team probe, never the grant", () => {
    const ctx = planContext(teamsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["org", "list", "probe"]);
    // @ts-expect-error a write role is not a read: the port has no `grant`
    ctx.read.grant;
    // @ts-expect-error an "absent" primary read offers no throwing helper
    ctx.read.org.call;
    // @ts-expect-error nor a list
    ctx.read.org.listAll;
    expect(typeof ctx.read.probe.probeAbsent).toBe("function");
    expect(typeof ctx.read.list.listAll).toBe("function");
  });

  describe("snapshot", () => {
    test("reads each listed team's role through the probe, not the listing's permission, so a custom role reads back by name; a probe 404 is noted with both readings", async () => {
      const api = new MockApi({
        [ORG]: { data: { login: "o" } },
        [LIST]: {
          data: [
            { slug: "platform", permission: "push", access_source: "direct" },
            { slug: "auditors", permission: "pull", access_source: "direct" },
            { slug: "everyone", permission: "pull", access_source: "organization" },
            { slug: "legacy", permission: "push" },
            { slug: "gone", permission: "push", access_source: "direct" },
            { slug: "roleless", permission: "push", access_source: "direct" },
            { slug: "pushy", permission: "push", access_source: "direct" },
          ],
        },
        [probeOf("platform")]: { data: { role_name: "write" } },
        [probeOf("auditors")]: { data: { role_name: "security-auditor" } },
        [probeOf("legacy")]: { data: { role_name: "read" } },
        [probeOf("gone")]: { error: { status: 404, message: "Not Found", body: "" } },
        [probeOf("roleless")]: { data: null },
        [probeOf("pushy")]: { data: { role_name: "push" } },
      });
      expect(await snapshot(api)).toEqual({
        value: [
          { name: "platform", permission: "push" },
          { name: "auditors", permission: "security-auditor" },
          { name: "legacy", permission: "pull" },
        ],
        notes: [
          "teams[everyone]: access to o/r is granted at the organization level, not on the repository; not declared, since declaring it would grant direct access",
          "teams[gone]: listed with access to o/r, but the access probe answered 404, read here as no access; not declared. " +
            "A fine-grained token missing the grant gets the same answer; if the team does have access, " +
            'grant "Members" (read) under the PAT\'s Organization permissions and "Administration" (read and write) under its Repository permissions, then snapshot again',
          "teams[roleless]: has access to o/r, but GitHub reported no role for it; not declared - add the entry with the intended permission",
          'teams[pushy]: the live role "push" has no declaration that plans as itself ("push" in a settings file means the "write" role); not declared',
        ],
      });
      expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        ORG,
        LIST,
        probeOf("platform"),
        probeOf("auditors"),
        probeOf("legacy"),
        probeOf("gone"),
        probeOf("roleless"),
        probeOf("pushy"),
      ]);
    });

    test("a personal account snapshots nothing after the org probe alone; an org repo with no team access snapshots nothing after the list", async () => {
      const personal = new MockApi({});
      expect(await snapshot(personal)).toEqual({
        value: undefined,
        notes: [
          'teams: owner "o" is a personal account, not an organization, so team access does not apply',
        ],
      });
      expect(personal.calls.map((c) => `${c.method} ${c.path}`)).toEqual([ORG]);
      const empty = new MockApi({ [ORG]: { data: { login: "o" } }, [LIST]: { data: [] } });
      expect(await snapshot(empty)).toEqual({ value: undefined, notes: [] });
      expect(empty.calls.map((c) => `${c.method} ${c.path}`)).toEqual([ORG, LIST]);
    });
  });
});
