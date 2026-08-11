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

/** A rules-query response over the given nodes, MockApi-route shaped. */
function rulesData(nodes: unknown[]): { data: Record<string, unknown> } {
  return {
    data: {
      repository: {
        branchProtectionRules: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  };
}

/** One live rule node with GitHub's fresh-rule defaults for selected fields. */
function ruleNode(
  pattern: string,
  fields: Record<string, unknown> = {},
  actors: unknown[] = [],
): Record<string, unknown> {
  return {
    id: `RULE:${pattern}`,
    pattern,
    requiresDeployments: false,
    requiredDeploymentEnvironments: [],
    bypassForcePushAllowances: { nodes: actors },
    ...fields,
  };
}

describe("branches GraphQL-routed keys", () => {
  test("apply: bypassers and deployments ride ONE update mutation after the PUT", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([ruleNode("main")]),
      "GRAPHQL BranchProtectionActorUser": {
        data: { repository: { id: "R_1" }, user: { id: "U_1" } },
      },
      "GRAPHQL BranchProtectionActorTeam": {
        data: { repository: { id: "R_1" }, organization: { team: { id: "T_1" } } },
      },
      "GET /apps/deploy-gate": { data: { slug: "deploy-gate", node_id: "APP_1" } },
      "PUT /repos/o/r/branches/main/protection": { data: {} },
      "GRAPHQL UpdateBranchProtectionRule": {
        data: {
          updateBranchProtectionRule: {
            branchProtectionRule: {
              id: "RULE:main",
              pattern: "main",
              requiresDeployments: true,
              requiredDeploymentEnvironments: ["prod"],
            },
          },
        },
      },
    });
    await branchesSection.run(ctx(api), [
      {
        name: "main",
        protection: {
          enforce_admins: true,
          force_push_bypassers: ["octocat", "e2e-owner/platform", "app/deploy-gate"],
          required_deployments: { environments: ["prod"] },
        },
      },
    ]);
    const mutations = api.mutations().map((c) => `${c.method} ${c.path}`);
    expect(mutations).toEqual([
      "PUT /repos/o/r/branches/main/protection",
      "GRAPHQL UpdateBranchProtectionRule",
    ]);
    // The PUT payload must not carry the routed keys GitHub has no REST
    // field for; the single mutation carries both.
    const put = api.mutations()[0]?.payload as Record<string, unknown>;
    expect(Object.keys(put)).not.toContain("force_push_bypassers");
    expect(Object.keys(put)).not.toContain("required_deployments");
    const update = api.mutations()[1]?.payload as { input: Record<string, unknown> };
    expect(update.input).toEqual({
      branchProtectionRuleId: "RULE:main",
      bypassForcePushActorIds: ["U_1", "T_1", "APP_1"],
      requiresDeployments: true,
      requiredDeploymentEnvironments: ["prod"],
    });
  });

  test("apply: a dropped required-deployment environment fails loudly by name", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([ruleNode("main")]),
      "PUT /repos/o/r/branches/main/protection": { data: {} },
      "GRAPHQL UpdateBranchProtectionRule": {
        data: {
          updateBranchProtectionRule: {
            branchProtectionRule: {
              id: "RULE:main",
              pattern: "main",
              requiresDeployments: true,
              requiredDeploymentEnvironments: ["prod"],
            },
          },
        },
      },
    });
    await expect(
      branchesSection.run(ctx(api), [
        {
          name: "main",
          protection: {
            enforce_admins: true,
            required_deployments: { environments: ["prod", "ghost"] },
          },
        },
      ]),
    ).rejects.toThrow(/silently dropped \[ghost\].*environments: section/s);
  });

  test("check: routed-key drift compares actor strings and environment sets", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main/protection": {
        data: { enforce_admins: { enabled: true } },
      },
      "GRAPHQL BranchProtectionRules": rulesData([
        ruleNode("main", { requiresDeployments: true, requiredDeploymentEnvironments: ["qa"] }, [
          { actor: { __typename: "User", login: "octocat" } },
        ]),
      ]),
    });
    const result = await branchesSection.run(ctx(api, true), [
      {
        name: "main",
        protection: {
          enforce_admins: true,
          force_push_bypassers: ["release-bot"],
          required_deployments: { environments: ["prod"] },
        },
      },
    ]);
    expect(result.drift).toHaveLength(2);
    expect(result.drift[0]).toContain(
      "force_push_bypassers: the settings file declares [release-bot] but the live rule allows [octocat]",
    );
    expect(result.drift[1]).toContain("required_deployments");
    expect(result.drift[1]).toContain("[qa]");
    expect(api.mutations()).toHaveLength(0);
  });

  test("check: matching routed keys are clean, order-insensitively", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main/protection": {
        data: { enforce_admins: { enabled: true } },
      },
      "GRAPHQL BranchProtectionRules": rulesData([
        ruleNode("main", { requiresDeployments: true, requiredDeploymentEnvironments: ["prod"] }, [
          { actor: { __typename: "App", slug: "deploy-gate" } },
          { actor: { __typename: "User", login: "octocat" } },
        ]),
      ]),
    });
    const result = await branchesSection.run(ctx(api, true), [
      {
        name: "main",
        protection: {
          enforce_admins: true,
          force_push_bypassers: ["octocat", "app/deploy-gate"],
          required_deployments: { environments: ["prod"] },
        },
      },
    ]);
    expect(result.drift).toEqual([]);
  });

  test("an unknown team resolves to a named config error, not a node-id crash", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([ruleNode("main")]),
      "PUT /repos/o/r/branches/main/protection": { data: {} },
      "GRAPHQL BranchProtectionActorTeam": {
        data: { repository: { id: "R_1" }, organization: { team: null } },
      },
    });
    await expect(
      branchesSection.run(ctx(api), [
        {
          name: "main",
          protection: { enforce_admins: true, force_push_bypassers: ["e2e-owner/ghost-team"] },
        },
      ]),
    ).rejects.toThrow(/no team with slug "ghost-team"/);
  });
});

describe("branches wildcard entries", () => {
  test("apply: create, update, and delete route entirely through GraphQL", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([
        ruleNode("hotfix/*", { requiresApprovingReviews: true, requiredApprovingReviewCount: 1 }),
        ruleNode("old/*"),
      ]),
      "GRAPHQL BranchProtectionRepository": { data: { repository: { id: "R_1" } } },
      "GRAPHQL CreateBranchProtectionRule": {
        data: {
          createBranchProtectionRule: {
            branchProtectionRule: ruleNode("release/*", { isAdminEnforced: true }),
          },
        },
      },
      "GRAPHQL UpdateBranchProtectionRule": {
        data: {
          updateBranchProtectionRule: { branchProtectionRule: ruleNode("hotfix/*") },
        },
      },
      "GRAPHQL DeleteBranchProtectionRule": {
        data: { deleteBranchProtectionRule: { clientMutationId: null } },
      },
    });
    const result = await branchesSection.run(ctx(api), [
      { name: "release/*", protection: { enforce_admins: true } },
      {
        name: "hotfix/*",
        protection: { required_pull_request_reviews: { required_approving_review_count: 2 } },
      },
      { name: "old/*", protection: null },
    ]);
    expect(api.mutations().map((c) => `${c.method} ${c.path}`)).toEqual([
      "GRAPHQL CreateBranchProtectionRule",
      "GRAPHQL UpdateBranchProtectionRule",
      "GRAPHQL DeleteBranchProtectionRule",
    ]);
    const create = api.mutations()[0]?.payload as { input: Record<string, unknown> };
    expect(create.input).toEqual({
      repositoryId: "R_1",
      pattern: "release/*",
      isAdminEnforced: true,
    });
    const update = api.mutations()[1]?.payload as { input: Record<string, unknown> };
    expect(update.input).toEqual({
      branchProtectionRuleId: "RULE:hotfix/*",
      requiresApprovingReviews: true,
      requiredApprovingReviewCount: 2,
    });
    expect(result.changes).toEqual([
      'created protection rule "release/*"',
      'updated protection rule "hotfix/*"',
      'deleted protection rule "old/*"',
    ]);
  });

  test("check: a live wildcard rule diffs through the classic view", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([
        ruleNode("release/*", {
          isAdminEnforced: false,
          requiresStatusChecks: true,
          requiresStrictStatusChecks: true,
          requiredStatusCheckContexts: ["ci"],
        }),
      ]),
    });
    const result = await branchesSection.run(ctx(api, true), [
      {
        name: "release/*",
        protection: {
          enforce_admins: true,
          required_status_checks: { strict: true, contexts: ["ci"] },
        },
      },
    ]);
    expect(result.drift).toEqual(["branches[release/*].protection.enforce_admins: true != false"]);
  });

  test("a live wildcard rule the file does not declare earns a note, never a delete", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main/protection": {
        data: { enforce_admins: { enabled: true } },
      },
      "GRAPHQL BranchProtectionRules": rulesData([ruleNode("legacy/*")]),
    });
    const result = await branchesSection.run(ctx(api, true), [
      { name: "main", protection: { enforce_admins: true, force_push_bypassers: [] } },
    ]);
    expect(result.notes).toEqual([
      'undeclared classic protection rule "legacy/*" exists on the repo - declare it to manage it (this action never deletes undeclared rules)',
    ]);
    expect(api.mutations()).toHaveLength(0);
  });

  test("a pure-REST declaration issues no GraphQL request at all", async () => {
    const api = new MockApi({
      "PUT /repos/o/r/branches/main/protection": { data: {} },
    });
    await branchesSection.run(ctx(api), [{ name: "main", protection: { enforce_admins: true } }]);
    expect(api.calls.filter((c) => c.method === "GRAPHQL")).toHaveLength(0);
  });

  test("an untranslatable wildcard key fails the shape naming the supported set", () => {
    const parsed = branchesSection.shape.safeParse([
      {
        name: "release/*",
        protection: { enforce_admins: true, restrictions: { users: [], teams: [] } },
      },
    ]);
    expect(parsed.success).toBe(false);
    const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
    expect(
      messages.some((m) => m.includes("protection.restrictions") && m.includes("rulesets section")),
    ).toBe(true);
    // The same key on a LITERAL entry stays a passthrough.
    expect(
      branchesSection.shape.safeParse([
        { name: "main", protection: { restrictions: { users: [], teams: [] } } },
      ]).success,
    ).toBe(true);
  });

  test("an unknown wildcard sub-key and a malformed actor both fail upfront", () => {
    const nested = branchesSection.shape.safeParse([
      {
        name: "release/*",
        protection: { required_status_checks: { strict: true, checks: [] } },
      },
    ]);
    expect(nested.success).toBe(false);
    const actor = branchesSection.shape.safeParse([
      { name: "main", protection: { force_push_bypassers: ["a/b/c"] } },
    ]);
    expect(actor.success).toBe(false);
    const messages = actor.success ? [] : actor.error.issues.map((issue) => issue.message);
    expect(messages.some((m) => m.includes("bare user login"))).toBe(true);
  });

  test("a scalar structured key on a wildcard entry fails the shape, not apply", () => {
    // Without this rejection the value passes the looseObject and crashes
    // translateWildcardProtection mid-apply with a raw TypeError - a config
    // that survives check mode must never blow up on apply.
    for (const bad of [
      { required_status_checks: true },
      { required_pull_request_reviews: 5 },
      { required_status_checks: ["ci"] },
    ]) {
      const parsed = branchesSection.shape.safeParse([{ name: "release/*", protection: bad }]);
      expect(parsed.success).toBe(false);
      const messages = parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes("must be a mapping of its sub-keys"))).toBe(true);
    }
    // The same scalar on a LITERAL entry stays a passthrough (GitHub is the
    // authority on the REST payload).
    expect(
      branchesSection.shape.safeParse([
        { name: "main", protection: { required_status_checks: true } },
      ]).success,
    ).toBe(true);
  });

  test("case-insensitive duplicates in the routed lists fail upfront", () => {
    const actors = branchesSection.shape.safeParse([
      { name: "main", protection: { force_push_bypassers: ["octocat", "OctoCat"] } },
    ]);
    expect(actors.success).toBe(false);
    const envs = branchesSection.shape.safeParse([
      {
        name: "main",
        protection: { required_deployments: { environments: ["prod", "Prod"] } },
      },
    ]);
    expect(envs.success).toBe(false);
  });

  test("check: routed keys compare case-insensitively (GitHub canonicalizes names)", async () => {
    const api = new MockApi({
      "GET /repos/o/r/branches/main/protection": {
        data: { enforce_admins: { enabled: true } },
      },
      "GRAPHQL BranchProtectionRules": rulesData([
        ruleNode("main", { requiresDeployments: true, requiredDeploymentEnvironments: ["prod"] }, [
          { actor: { __typename: "User", login: "octocat" } },
        ]),
      ]),
    });
    const result = await branchesSection.run(ctx(api, true), [
      {
        name: "main",
        protection: {
          enforce_admins: true,
          force_push_bypassers: ["OctoCat"],
          required_deployments: { environments: ["Prod"] },
        },
      },
    ]);
    expect(result.drift).toEqual([]);
  });

  test("apply: a misspelled actor fails BEFORE the destructive protection PUT", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([ruleNode("main")]),
      "GRAPHQL BranchProtectionActorUser": {
        data: { repository: { id: "R_1" }, user: null },
      },
    });
    await expect(
      branchesSection.run(ctx(api), [
        {
          name: "main",
          protection: { enforce_admins: true, force_push_bypassers: ["ghost"] },
        },
      ]),
    ).rejects.toThrow(/GraphQL lookup succeeded but returned no node id/);
    expect(api.mutations()).toHaveLength(0);
  });

  test("apply: a mutation payload without a rule fails the read-back with its own message", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([ruleNode("main")]),
      "PUT /repos/o/r/branches/main/protection": { data: {} },
      "GRAPHQL UpdateBranchProtectionRule": {
        data: { updateBranchProtectionRule: { branchProtectionRule: null } },
      },
    });
    await expect(
      branchesSection.run(ctx(api), [
        {
          name: "main",
          protection: {
            enforce_admins: true,
            required_deployments: { environments: ["prod"] },
          },
        },
      ]),
    ).rejects.toThrow(/returned no rule to read back/);
  });

  test("a live rule with a truncated allowance page fails loudly by pattern", async () => {
    const api = new MockApi({
      "GRAPHQL BranchProtectionRules": rulesData([
        {
          ...ruleNode("release/*"),
          bypassForcePushAllowances: { nodes: [], pageInfo: { hasNextPage: true } },
        },
      ]),
    });
    await expect(
      branchesSection.run(ctx(api, true), [
        { name: "release/*", protection: { enforce_admins: true } },
      ]),
    ).rejects.toThrow(/more than 100 force-push bypass actors/);
  });
});
