/**
 * The probe's reply shape is decided by the request's Accept media type, which no scenario can assert on, so
 * it is pinned here against the handler and, through the fragment fake, against the section's own probe.
 */

import { describe, expect, test } from "bun:test";
import { planContext, snapshotContext } from "../../../src/sections/contract/plan.js";
import { teamsSection } from "../../../src/sections/teams/index.js";
import { handlerTestContext } from "../../e2e/mock/handler-test-ctx.js";
import { buildStateForSlug } from "../../e2e/mock/state.js";
import { fragmentFake } from "../fragment-fake.js";
import { REPO, unwrap } from "../section-run.js";
import { validatedInput } from "../validated-input.js";
import { TEAM_REPOSITORY_MEDIA_TYPE, teamsMockHandlers } from "./mock.js";

const LIVE = { teams: { platform: { role_name: "write" } } };
const PROBE_PARAMS = { org: "acme", team_slug: "platform", owner: "acme", repo: "widgets" };

function probe(headers: Record<string, string>) {
  const state = buildStateForSlug("acme/widgets", { settingsYaml: null, liveState: LIVE }, "org");
  return teamsMockHandlers["teams.probe"](
    handlerTestContext("teams.probe", state, { params: PROBE_PARAMS, headers }),
  );
}

describe("teams.probe answers by Accept media type, like GitHub", () => {
  test("the repository media type, in any header casing, gets the 200 body carrying role_name", () => {
    const response = probe({ Accept: TEAM_REPOSITORY_MEDIA_TYPE });
    expect(response.status).toBe(200);
    expect((response.body as { role_name: unknown; full_name: unknown }).role_name).toBe("write");
    expect((response.body as { full_name: unknown }).full_name).toBe("acme/widgets");
  });

  test("the default JSON media type gets the bare 204: access confirmed, no role to read", () => {
    expect(probe({ accept: "application/vnd.github+json" })).toEqual({ status: 204, body: null });
  });

  test("the section's probe sends the media type: a converged team plans nothing and snapshots its role", async () => {
    const api = fragmentFake(teamsSection, teamsMockHandlers, LIVE);
    expect(
      unwrap(
        await teamsSection.plan(
          planContext(teamsSection, api, REPO),
          validatedInput("teams", [{ name: "platform", permission: "push" }]),
        ),
      ),
    ).toEqual({
      ops: [],
      notes: [],
      drift: [],
    });
    expect(
      unwrap(await teamsSection.snapshot(snapshotContext(teamsSection, api, REPO, "fail"))),
    ).toEqual({
      value: { _undeclared: "keep", entries: [{ name: "platform", permission: "push" }] },
      notes: [],
    });
    expect(api.writes).toEqual([]);
  });
});

describe("teams.grant answers a permission like GitHub", () => {
  const params = { org: "acme", team_slug: "platform", owner: "acme", repo: "widgets" };

  test.each<[permission: string, status: number, stored: { role_name: string }]>([
    ["write", 422, { role_name: "write" }],
    ["read", 422, { role_name: "write" }],
    ["Push", 422, { role_name: "write" }],
    ["security-auditor", 204, { role_name: "security-auditor" }],
  ])("%j is a %i, and the team's role is then %j", (permission, status, stored) => {
    const state = buildStateForSlug("acme/widgets", { settingsYaml: null, liveState: LIVE }, "org");
    const response = teamsMockHandlers["teams.grant"](
      handlerTestContext("teams.grant", state, { params, body: { permission } }),
    );
    expect(response.status).toBe(status);
    expect(state.teams.platform).toEqual(stored);
  });
});
