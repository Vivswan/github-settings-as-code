/**
 * The pipeline serves a handler's data as graphql-js completes it under the request's own document, and fails the run
 * on data GitHub's schema could never serialize. Without it a handler that stored a null hands it back in a Boolean!
 * field, a key the document never selected reaches the product, and every scenario passes on both.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { allGraphqlOps, type SectionGraphqlKey } from "../../../src/sections/registry.js";
import { ADMIN_OWNER as OWNER, ADMIN_REPO as REPO, VIOLATION_PREFIX } from "../constants.js";
import { runScenario, type ScenarioReport } from "../runner/runner.js";
import type { Scenario } from "../scenario.js";
import { type LoggedRequest, newPipelineRunState, type PipelineResult } from "./contract.js";
import { isWriteRequest } from "./dispatch.js";
import { completedGraphqlAnswer } from "./graphql-answer.js";
import { type AcceptedGraphqlRequest, acceptedGraphqlRequest } from "./graphql-request.js";
import { GRAPHQL_HANDLERS } from "./handlers.js";
import { handleGraphqlRequest } from "./routes.js";
import { scenario } from "./server-test-support.js";
import { buildState, completeRule, ruleWireNode } from "./state.js";
import type { Json } from "./support.js";

const OPS = allGraphqlOps();
const READ = { owner: OWNER, repo: REPO };
const NULL_ADMIN_ENFORCED =
  "data.repository.branchProtectionRules.nodes.0.isAdminEnforced: Cannot return null for non-nullable field BranchProtectionRule.isAdminEnforced.";
const NULL_ADMIN_ENFORCED_VIOLATION = `GraphQL BranchProtectionRules was answered off GitHub's schema by the mock handler "branches.rulesQuery": ${NULL_ADMIN_ENFORCED}`;

/** A wildcard rule node as the mock's own state builds one, `overrides` on top. */
function ruleNode(overrides: Json = {}): Json {
  return ruleWireNode(completeRule({ id: "BPR_1", pattern: "release/*", ...overrides }));
}

/** The rules read's data holding `nodes`. */
function rulesData(...nodes: Json[]): Json {
  return {
    repository: {
      branchProtectionRules: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}

/** The features read's data holding `repository`. */
function featuresData(repository: Json): Json {
  return { repository: { id: "R_1", ...repository } };
}

/** The declared operation `key` under `variables`, as GitHub accepts it. */
function accepted(key: SectionGraphqlKey, variables: Json): AcceptedGraphqlRequest {
  const request = acceptedGraphqlRequest(OPS[key].query, OPS[key].name, variables);
  if ("errors" in request) {
    throw new Error(`${key} is refused by GitHub's schema: ${JSON.stringify(request.errors)}`);
  }
  return request;
}

/** The pipeline's result for the declared operation `key` when its handler answers `data`. */
function served(key: SectionGraphqlKey, variables: Json, data: Json): PipelineResult {
  const op = OPS[key];
  const body = { query: op.query, operationName: op.name, variables };
  const run = scenario();
  const log: LoggedRequest = { method: "POST", pathname: "/graphql", query: "", status: 0, body };
  return handleGraphqlRequest(
    { method: "POST", body },
    {
      scenario: run,
      working: { mode: "single", state: buildState(run.live_state, run.owner_kind) },
      checkMode: false,
      ...newPipelineRunState(),
    },
    log,
    OPS,
    { ...GRAPHQL_HANDLERS, [key]: () => ({ data }) },
  );
}

/** One scenario run of the real bundle; the artifact directory a failing run dumps is removed, the report carries what the assertions read. */
async function scenarioRun(run: Scenario): Promise<ScenarioReport> {
  const report = await runScenario(run);
  if (report.artifactDir !== undefined) {
    rmSync(report.artifactDir, { recursive: true, force: true });
  }
  return report;
}

describe("data GitHub's schema could never serialize does not complete", () => {
  test.each([
    {
      name: "a null in a non-null field",
      key: "branches.rulesQuery",
      data: rulesData(ruleNode({ isAdminEnforced: null })),
      line: NULL_ADMIN_ENFORCED,
    },
    {
      name: "a selected non-null field the data lacks",
      key: "repository.featuresQuery",
      data: featuresData({ issueCreationPolicy: "ALL" }),
      line: "data.repository.hasSponsorshipsEnabled: Cannot return null for non-nullable field Repository.hasSponsorshipsEnabled.",
    },
    {
      name: "a value off its enum",
      key: "repository.featuresQuery",
      data: featuresData({ hasSponsorshipsEnabled: false, issueCreationPolicy: "all" }),
      line: 'data.repository.issueCreationPolicy: Enum "IssueCreationPolicy" cannot represent value: "all"',
    },
    {
      name: "1.5 for an Int",
      key: "branches.rulesQuery",
      data: rulesData(ruleNode({ requiredApprovingReviewCount: 1.5 })),
      line: "data.repository.branchProtectionRules.nodes.0.requiredApprovingReviewCount: Int cannot represent non-integer value: 1.5",
    },
    {
      // The line goes on with graphql-js's advice to its own caller.
      name: "an abstract value that names no type",
      key: "branches.rulesQuery",
      data: rulesData({
        ...ruleNode(),
        bypassForcePushAllowances: {
          nodes: [{ actor: { login: "octocat" } }],
          pageInfo: { hasNextPage: false },
        },
      }),
      line: 'data.repository.branchProtectionRules.nodes.0.bypassForcePushAllowances.nodes.0.actor: Abstract type "BranchActorAllowanceActor" must resolve to an Object type at runtime',
    },
  ] as const)("$name", ({ key, data, line }) => {
    expect(completedGraphqlAnswer(accepted(key, READ), data)).toEqual({
      errors: [expect.stringContaining(line)],
    });
  });

  test("control: data on the schema completes to itself, a union member named by its __typename included", () => {
    const data = rulesData(ruleNode({ bypassForcePushActors: ["octocat"] }));
    expect(completedGraphqlAnswer(accepted("branches.rulesQuery", READ), data)).toEqual({ data });
  });
});

describe("the product receives a handler's data through the request's selection", () => {
  test.each([
    {
      name: "a key the document does not select is dropped",
      key: "repository.featuresQuery",
      data: featuresData({
        hasSponsorshipsEnabled: true,
        issueCreationPolicy: "ALL",
        nameWithOwner: `${OWNER}/${REPO}`,
      }),
      received: featuresData({ hasSponsorshipsEnabled: true, issueCreationPolicy: "ALL" }),
    },
    {
      name: "a selected nullable key the handler leaves out is null",
      key: "environments.pins",
      data: { repository: { pinnedEnvironments: { nodes: [], pageInfo: { hasNextPage: false } } } },
      received: {
        repository: {
          pinnedEnvironments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
    {
      name: "control: data that is the selection already is served as it is",
      key: "branches.rulesQuery",
      data: rulesData(ruleNode()),
      received: rulesData(ruleNode()),
    },
  ] as const)("$name", ({ key, data, received }) => {
    const result = served(key, READ, data);
    expect(result.violation).toBeUndefined();
    expect(result.response).toEqual({ status: 200, body: { data: received } });
  });
});

describe("data that does not complete fails the run", () => {
  test("the violation names the operation, the handler, the path, and graphql-js's reason, and the read stays a read in the log", () => {
    const result = served(
      "branches.rulesQuery",
      READ,
      rulesData(ruleNode({ isAdminEnforced: null })),
    );
    expect(result.violation).toBe(NULL_ADMIN_ENFORCED_VIOLATION);
    // The product is answered the violation, never the data.
    expect(result.response).toEqual({
      status: 400,
      body: { message: `${VIOLATION_PREFIX} ${NULL_ADMIN_ENFORCED_VIOLATION}` },
    });
    // Logged without its GraphQL kind, the POST would count as a write in the runner's check-mode and idempotence rules.
    expect(result.log.graphql).toEqual({ operationName: "BranchProtectionRules", kind: "read" });
    expect(isWriteRequest(result.log)).toBe(false);
  });

  test("inside a scenario run: a handler answering a null in a Boolean! field fails the scenario with the violation, and the handlers as they are pass it (the control)", async () => {
    const wildcardRule = scenario({
      name: "graphql-answer-in-run",
      settings: { branches: [{ name: "release/*", protection: { enforce_admins: true } }] },
      live_state: { branch_protection_rules: [{ pattern: "release/*", isAdminEnforced: true }] },
    });
    const control = await scenarioRun(wildcardRule);
    expect(control.failures).toEqual([]);

    using mutant = spyOn(GRAPHQL_HANDLERS, "branches.rulesQuery").mockImplementation(() => ({
      data: rulesData(ruleNode({ isAdminEnforced: null })),
    }));
    const report = await scenarioRun(wildcardRule);
    expect(mutant).toHaveBeenCalled();
    // Every rules read of the run earns the line; how many the product makes is not this test's subject.
    expect(report.failures[0]).toStartWith(`mock violations:\n  ${NULL_ADMIN_ENFORCED_VIOLATION}`);
  }, 120_000);
});
