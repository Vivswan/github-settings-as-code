/**
 * The pipeline serves a handler's data as graphql-js completes it under the request's own document, and fails the run
 * on data GitHub's schema could never have produced. Without these tests the guard could stop firing and no scenario
 * would turn red: the corpus holds only answers on the schema.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseRepoSlug } from "../../../src/discovery/targets.js";
import { SectionSelection } from "../../../src/engine/section-selection.js";
import { runSingle } from "../../../src/flows/single.js";
import { GitHubApi } from "../../../src/github/api.js";
import { silentIo } from "../../../src/io.js";
import { allGraphqlOps, type SectionGraphqlKey } from "../../../src/sections/registry.js";
import { withTempDir } from "../../temp-dir.js";
import {
  ADMIN_SLUG,
  E2E_TOKEN,
  ADMIN_OWNER as OWNER,
  ADMIN_REPO as REPO,
  VIOLATION_PREFIX,
} from "../constants.js";
import { type LoggedRequest, newPipelineRunState, type PipelineResult } from "./contract.js";
import { isWriteRequest } from "./dispatch.js";
import { completedGraphqlAnswer } from "./graphql-answer.js";
import { type AcceptedGraphqlRequest, acceptedGraphqlRequest } from "./graphql-request.js";
import { GRAPHQL_HANDLERS } from "./handlers.js";
import { mintNodeId } from "./node-id.js";
import { handleGraphqlRequest } from "./routes.js";
import { mockServerLifecycle, scenario } from "./server-test-support.js";
import { buildState, completeRule, ruleWireNode } from "./state.js";
import type { Json } from "./support.js";

const start = mockServerLifecycle();
const OPS = allGraphqlOps();
const READ = { owner: OWNER, repo: REPO };
const DELETE_RULE = {
  input: { branchProtectionRuleId: mintNodeId("rule", ADMIN_SLUG, "release/*") },
};
const NUMBER_FOR_A_PAYLOAD =
  'data.deleteBranchProtectionRule: answered 7, the schema serves {"clientMutationId":null}';
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

/**
 * One check run of the product's own code, in-process and over the wire, on a settings file that matches the mock's one
 * wildcard rule. Returns the run's result and the violations the mock recorded, the list the runner fails a scenario on.
 */
async function checkRun(dir: string): Promise<{ result: string; violations: string[] }> {
  const mock = await start(
    scenario({
      live_state: { branch_protection_rules: [{ pattern: "release/*", isAdminEnforced: true }] },
    }),
  );
  const settingsFile = join(dir, "settings.yml");
  const settings = { branches: [{ name: "release/*", protection: { enforce_admins: true } }] };
  writeFileSync(settingsFile, stringifyYaml(settings));
  const io = silentIo();
  const client = new GitHubApi({ token: E2E_TOKEN, io, baseUrl: mock.url, retryBaseMs: 1 });

  const outcome = await runSingle(
    client,
    {
      mode: "check",
      repo: parseRepoSlug(ADMIN_SLUG)._unsafeUnwrap(),
      settingsFile,
      selfSlug: ADMIN_SLUG,
      privateRepos: "redact",
      onMissingPermission: "fail",
      sections: SectionSelection.ALL,
      privateReport: "none",
      reportPublicKey: "",
      runUrl: "",
    },
    io,
  );
  return { result: outcome._unsafeUnwrap().result, violations: mock.violations };
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

// graphql-js completes each of these without an error: an object of nulls for a non-object, the coerced value for a leaf.
describe("data that completes to anything but itself is no answer of GitHub's schema", () => {
  test.each([
    {
      name: "a number at an object position",
      key: "branches.deleteRule",
      variables: DELETE_RULE,
      data: { deleteBranchProtectionRule: 7 },
      line: NUMBER_FOR_A_PAYLOAD,
    },
    {
      name: "an array at an object position",
      key: "branches.deleteRule",
      variables: DELETE_RULE,
      data: { deleteBranchProtectionRule: [] },
      line: 'data.deleteBranchProtectionRule: answered [], the schema serves {"clientMutationId":null}',
    },
    {
      name: "a string as the whole data",
      key: "environments.pins",
      variables: READ,
      data: "not an object",
      line: 'data: answered "not an object", the schema serves {"repository":null}',
    },
    {
      name: "a string inside a list of objects",
      key: "branches.rulesQuery",
      variables: READ,
      data: rulesData({
        ...ruleNode(),
        bypassForcePushAllowances: { nodes: ["octocat"], pageInfo: { hasNextPage: false } },
      }),
      line: 'data.repository.branchProtectionRules.nodes.0.bypassForcePushAllowances.nodes.0: answered "octocat", the schema serves {"actor":null}',
    },
    {
      name: "true for an Int",
      key: "branches.rulesQuery",
      variables: READ,
      data: rulesData(ruleNode({ requiredApprovingReviewCount: true })),
      line: "data.repository.branchProtectionRules.nodes.0.requiredApprovingReviewCount: answered true, the schema serves 1",
    },
    {
      name: "5 for an ID",
      key: "repository.featuresQuery",
      variables: READ,
      data: { repository: { id: 5, hasSponsorshipsEnabled: false, issueCreationPolicy: "ALL" } },
      line: 'data.repository.id: answered 5, the schema serves "5"',
    },
  ] as const)("$name", ({ key, variables, data, line }) => {
    expect(completedGraphqlAnswer(accepted(key, variables), data)).toEqual({ errors: [line] });
  });
});

describe("the product receives the completed data, and its two differences from the handler's data are no violation", () => {
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

describe("data off the schema fails the run", () => {
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

  test("data that completes to another value is a violation naming the path and both values", () => {
    const result = served("branches.deleteRule", DELETE_RULE, { deleteBranchProtectionRule: 7 });
    const violation = `GraphQL DeleteBranchProtectionRule was answered off GitHub's schema by the mock handler "branches.deleteRule": ${NUMBER_FOR_A_PAYLOAD}`;
    expect(result.violation).toBe(violation);
    expect(result.response).toEqual({
      status: 400,
      body: { message: `${VIOLATION_PREFIX} ${violation}` },
    });
  });

  test("inside a run of the product: a handler answering a null in a Boolean! field fails the run and records the violation, and the handlers as they are run clean (the control)", () =>
    withTempDir("graphql-answer-run-", async (dir) => {
      expect(await checkRun(dir)).toEqual({ result: "clean", violations: [] });

      using mutant = spyOn(GRAPHQL_HANDLERS, "branches.rulesQuery").mockImplementation(() => ({
        data: rulesData(ruleNode({ isAdminEnforced: null })),
      }));
      const refused = await checkRun(dir);
      expect(mutant).toHaveBeenCalled();
      expect(refused.result).toBe("failed");
      // Every rules read of the run earns the line; how many the product makes is not this test's subject.
      expect(new Set(refused.violations)).toEqual(new Set([NULL_ADMIN_ENFORCED_VIOLATION]));
    }));
});
