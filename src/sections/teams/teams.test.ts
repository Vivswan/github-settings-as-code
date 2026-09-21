import { describe, expect, test } from "bun:test";
import type { SectionInput, SectionModule } from "../../../src/sections/contract/module.js";
import { planContext, snapshotContext } from "../../../src/sections/contract/plan.js";
import { sectionModule } from "../../../src/sections/registry.js";
import { MockApi } from "../../../test/mock-api.js";
import { fragmentFake } from "../../../test/sections/fragment-fake.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../test/sections/section-run.js";
import { validatedInput } from "../../../test/sections/validated-input.js";
import { teamsSection } from "./index.js";
import { teamsMockHandlers } from "./mock.js";

/** The registered module: the owner gate the registry composes is part of the behavior under test. */
const gated = sectionModule("teams") as SectionModule<"teams"> &
  Required<Pick<SectionModule<"teams">, "snapshot">>;

const ORG = "GET /orgs/o";
const LIST = "GET /repos/o/r/teams?per_page=100&page=1";
const probeOf = (slug: string) => `GET /orgs/o/teams/${slug}/repos/o/r`;
const plan = async (api: MockApi, desired: SectionInput<"teams">) =>
  unwrap(await gated.plan(planContext(gated, api, REPO), validatedInput("teams", desired)));
const snapshot = async (api: MockApi) =>
  unwrap(await gated.snapshot(snapshotContext(gated, api, REPO, "fail")));

describe("teams", () => {
  test("a personal account no-ops with a note after the org probe alone", async () => {
    const api = new MockApi({});
    const result = await plan(api, [{ name: "platform", permission: "push" }]);
    expect(result).toEqual({
      ops: [],
      notes: [
        'teams: owner "o" is a personal account, not an organization, so this section does not apply; section skipped - remove the teams section from the settings file to silence this note',
      ],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([ORG]);
  });

  test("plans a grant per team without access or at a divergent role, and nothing for a converged one", async () => {
    const api = new MockApi({
      [ORG]: { data: { login: "o" } },
      [LIST]: { data: [] },
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
            'teams[platform]: declared "write" != live "read"; apply will set the declared permission',
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
      LIST,
      probeOf("platform"),
      probeOf("ops"),
      probeOf("new"),
    ]);
  });

  test("an undeclared team with direct access is kept with a note by default; access granted above the repository passes silently", async () => {
    const api = new MockApi({
      [ORG]: { data: { login: "o" } },
      [LIST]: {
        data: [
          { slug: "platform", access_source: "direct" },
          { slug: "legacy", access_source: "direct" },
          { slug: "everyone", access_source: "organization" },
        ],
      },
      [probeOf("platform")]: { data: { role_name: "write" } },
    });
    const result = await plan(api, [{ name: "platform", permission: "push" }]);
    expect(result).toEqual({
      ops: [],
      notes: [
        'team "legacy" has access but is not declared in the settings file; kept under "_undeclared: keep" - add it to the settings file to manage its access, or set "_undeclared: delete" to have apply REVOKE its access',
      ],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([ORG, LIST, probeOf("platform")]);
  });

  test('under "_undeclared: delete" access granted above the repository is noted as beyond the repository\'s reach', async () => {
    const api = new MockApi({
      [ORG]: { data: { login: "o" } },
      [LIST]: { data: [{ slug: "everyone", access_source: "organization" }] },
    });
    const result = await plan(api, { _undeclared: "delete", entries: [] });
    expect(result).toEqual({
      ops: [],
      notes: [
        'teams[everyone]: access to o/r is granted at the organization level, not on the repository, so "_undeclared: delete" cannot revoke it; left untouched',
      ],
      drift: [],
    });
  });

  test('under "_undeclared: delete" an undeclared direct team is revoked, and the re-plan is empty', async () => {
    const api = fragmentFake(teamsSection, teamsMockHandlers, {
      teams: { platform: { role_name: "write" }, legacy: { role_name: "read" } },
    });
    const { first, second, changes } = await provePlanIdempotent(teamsSection, api, {
      _undeclared: "delete",
      entries: [{ name: "platform", permission: "push" }],
    });
    expect(first.ops.map((op) => op.drift)).toEqual([
      [
        'teams[legacy]: undeclared - not in the settings file and "_undeclared: delete" is set, so apply will REVOKE its access; add it to the settings file to keep its access',
      ],
    ]);
    expect(changes).toEqual(['REVOKED undeclared team "legacy"']);
    expect(api.writes).toEqual(["DELETE /orgs/o/teams/legacy/repos/o/r"]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.state.teams).toEqual({ platform: { role_name: "write" }, legacy: null });
  });

  test("a bare 204 probe body reads as access without a role, so the declared role is drift", async () => {
    const api = new MockApi({
      [ORG]: { data: { login: "o" } },
      [LIST]: { data: [] },
      [probeOf("platform")]: { data: null },
    });
    const result = await plan(api, [{ name: "platform", permission: "pull" }]);
    expect(result.ops.map((op) => op.drift)).toEqual([
      ['teams[platform]: declared "read" != live ""; apply will set the declared permission'],
    ]);
  });

  test("only a 404 on the org probe reads as a personal account; a 403 fails the section", async () => {
    const api = new MockApi({
      [ORG]: { error: { status: 403, message: "Forbidden", body: "" } },
    });
    await expect(plan(api, [{ name: "platform" }])).rejects.toThrow(/403/);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([ORG]);
  });

  test("two entries naming the same slug in different case are a validate issue, so the document fails before the owner probe", () => {
    expect(teamsSection.validate([{ name: "ops" }, { name: "Ops", permission: "pull" }])).toEqual([
      {
        path: "[1].name",
        message:
          '"Ops" names the same team as "ops" declared earlier; keep exactly one entry per team',
      },
    ]);
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

  test("the read port exposes the public org probe, the list in its denied posture, and the team probe, never a write", () => {
    const ctx = planContext(teamsSection, new MockApi({}), REPO);
    expect(Object.keys(ctx.read)).toEqual(["org", "list", "probe"]);
    // @ts-expect-error a write role is not a read: the port has no `grant`
    ctx.read.grant;
    // @ts-expect-error nor a `revoke`
    ctx.read.revoke;
    // @ts-expect-error a "denied" primary read offers no absent probe: its 404 is a denial
    ctx.read.list.probeAbsent;
    // @ts-expect-error nor a tolerant call
    ctx.read.list.tryCall;
    expect(typeof ctx.read.org.probeAbsent).toBe("function");
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
        value: {
          _undeclared: "keep",
          entries: [
            { name: "platform", permission: "push" },
            { name: "auditors", permission: "security-auditor" },
            { name: "legacy", permission: "pull" },
          ],
        },
        notes: [
          "teams[everyone]: left out of the snapshot - access to o/r is granted at the organization level, not on the repository, and declaring it would grant direct access",
          "teams[gone]: left out of the snapshot - listed with access to o/r, but the access probe answered 404, read here as no access. " +
            "A fine-grained token missing the grant gets the same answer; if the team does have access, " +
            'grant "Members" (read) under the PAT\'s Organization permissions and "Administration" (read and write) under its Repository permissions, then snapshot again',
          "teams[roleless]: left out of the snapshot - has access to o/r, but GitHub reported no role for it; add the entry with the intended permission",
          'teams[pushy]: left out of the snapshot - the live role "push" has no declaration that plans as itself ("push" in a settings file means the "write" role)',
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
          'teams: owner "o" is a personal account, not an organization, so this section does not apply',
        ],
      });
      expect(personal.calls.map((c) => `${c.method} ${c.path}`)).toEqual([ORG]);
      const empty = new MockApi({ [ORG]: { data: { login: "o" } }, [LIST]: { data: [] } });
      expect(await snapshot(empty)).toEqual({ value: undefined, notes: [] });
      expect(empty.calls.map((c) => `${c.method} ${c.path}`)).toEqual([ORG, LIST]);
    });
  });
});
