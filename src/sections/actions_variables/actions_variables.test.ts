import { describe, expect, test } from "bun:test";
import { executePlan } from "../../../src/engine/execute.js";
import type { GitHubClient } from "../../../src/github/api.js";
import { MockApi } from "../../../test/mock-api.js";
import { provePlanIdempotent } from "../../../test/sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../test/sections/section-run.js";
import { validatedInput } from "../../../test/sections/validated-input.js";
import type { SectionInput } from "../contract/module.js";
import { planContext } from "../contract/plan.js";
import { variableKey } from "../shared/variables-engine.js";
import { actionsVariablesSection } from "./index.js";

type Declared = SectionInput<"actions_variables">;

const PAGE_SIZE = actionsVariablesSection.endpoints.list.pageSize;
const listPage = (page: number) =>
  `/repos/o/r/actions/variables?per_page=${PAGE_SIZE}&page=${page}`;

/** The enveloped list body the mock serves for a live variable set. */
function listRoute(variables: Array<{ name: string; value: string }>) {
  return {
    [`GET ${listPage(1)}`]: {
      data: { total_count: variables.length, variables },
    },
  };
}

const plan = async (api: GitHubClient, declared: Declared) =>
  unwrap(
    await actionsVariablesSection.plan(
      planContext(actionsVariablesSection, api, REPO),
      validatedInput("actions_variables", declared),
    ),
  );
type Planned = Awaited<ReturnType<typeof plan>>;

/** Plan, then execute against the same client; a failed execution rethrows its error. */
async function apply(api: GitHubClient, declared: Declared) {
  const planned = await plan(api, declared);
  const execution = await executePlan(planned, actionsVariablesSection, api, REPO, {
    resolveSecret: () => {
      throw new Error("variables carry no secrets");
    },
  });
  if (execution.status === "failed") {
    throw new Error(execution.failure.message);
  }
  return { plan: planned, changes: execution.changes };
}

/** A stateful fake: the list reflects every write, so a re-plan sees converged state. */
function liveRepo(
  variables: Array<{ name: string; value: string }>,
): GitHubClient & { writes: string[] } {
  return {
    writes: [],
    async tryRequest(method, path, payload) {
      if (method === "GET") {
        return { data: { total_count: variables.length, variables } };
      }
      const body = payload as { name?: string; value: string };
      const name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
      if (method === "POST") {
        variables.push({ name: variableKey(body.name ?? ""), value: body.value });
      } else if (method === "PATCH") {
        const target = variables.find((v) => v.name === name);
        if (target === undefined) {
          return { error: { status: 404, message: "Not Found", body: "" } };
        }
        target.value = body.value;
      } else {
        variables.splice(
          variables.findIndex((v) => v.name === name),
          1,
        );
      }
      this.writes.push(`${method} ${path}`);
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the actions_variables section issues no GraphQL");
    },
  };
}

describe("actions_variables", () => {
  const liveVariables = [
    { name: "DEPLOY_REGION", value: "us-east-1" },
    { name: "RETIRED_FLAG", value: "off" },
  ];

  test("plans an update for a drifted value, a create for a missing one, a delete for an undeclared one", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await plan(api, [
      { name: "DEPLOY_REGION", value: "eu-west-1" },
      { name: "BUILD_MODE", value: "release" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "update",
          params: { name: "DEPLOY_REGION" },
          payload: { value: "eu-west-1" },
          drift: [
            'actions_variables[DEPLOY_REGION].value: declared "eu-west-1" != live "us-east-1"; apply will set the declared value',
          ],
          change: 'updated Actions variable "DEPLOY_REGION"',
          describe: 'updating Actions variable "DEPLOY_REGION"',
        },
        {
          role: "create",
          payload: { name: "BUILD_MODE", value: "release" },
          drift: [
            "actions_variables[BUILD_MODE]: missing - declared in the settings file but not on the repo; apply will create it",
          ],
          change: 'created Actions variable "BUILD_MODE"',
          describe: 'creating Actions variable "BUILD_MODE"',
        },
        {
          role: "remove",
          params: { name: "RETIRED_FLAG" },
          drift: [
            "actions_variables[RETIRED_FLAG]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
          ],
          change: 'DELETED undeclared Actions variable "RETIRED_FLAG"',
          describe: 'deleting undeclared Actions variable "RETIRED_FLAG"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${listPage(1)}`]);
  });

  test("executing the plan converges: the re-plan over applied state is empty", async () => {
    const api = liveRepo([
      { name: "DEPLOY_REGION", value: "us-east-1" },
      { name: "RETIRED_FLAG", value: "off" },
    ]);
    const { second, changes } = await provePlanIdempotent(actionsVariablesSection, api, [
      { name: "deploy_region", value: "eu-west-1" },
      { name: "BUILD_MODE", value: "release" },
    ]);
    expect(changes).toEqual([
      'updated Actions variable "deploy_region"',
      'created Actions variable "BUILD_MODE"',
      'DELETED undeclared Actions variable "RETIRED_FLAG"',
    ]);
    // The update PATCHes the LIVE (uppercase) name even when declared lowercase.
    expect(api.writes).toEqual([
      "PATCH /repos/o/r/actions/variables/DEPLOY_REGION",
      "POST /repos/o/r/actions/variables",
      "DELETE /repos/o/r/actions/variables/RETIRED_FLAG",
    ]);
    expect(second).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("matches names case-insensitively: a lowercase declaration converges against the uppercase live name", async () => {
    const api = new MockApi(listRoute(liveVariables));
    const result = await plan(api, [
      { name: "deploy_region", value: "us-east-1" },
      { name: "Retired_Flag", value: "off" },
    ]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("two entries differing only in case are a validate issue, so the document fails before any API call", () => {
    expect(
      actionsVariablesSection.validate([
        { name: "deploy_region", value: "a" },
        { name: "DEPLOY_REGION", value: "b" },
      ]),
    ).toEqual([
      {
        path: "[1].name",
        message:
          '"DEPLOY_REGION" names the same variable as "deploy_region" declared earlier; keep exactly one entry per variable',
      },
    ]);
  });

  test("a passthrough value JSON cannot carry is refused by validation, so plan() never meets it", async () => {
    // The loose shape admits any extra key; document validation refuses a non-finite one, and plan() takes only
    // validated input, so NaN (which JSON would turn into null) never reaches the wire as a silent change of value.
    const api = new MockApi(listRoute([{ name: "PRESENT", value: "x" }]));
    const odd = { name: "NEW", value: "v", extra: Number.NaN };
    expect(() => validatedInput("actions_variables", [odd])).toThrow(
      "actions_variables[0].extra is NaN, which JSON cannot carry (it would become null); declare a finite number or remove the key",
    );
    // The control: a plain extra key rides through.
    const plain = await plan(api, [{ name: "NEW", value: "v", extra: 42 } as never]);
    expect(plain.ops.map((op) => op.payload)).toEqual([{ name: "NEW", value: "v", extra: 42 }]);
  });

  const converged = [{ name: "DEPLOY_REGION", value: "us-east-1" }];
  const retiredFlagDeleted: Planned = {
    ops: [
      {
        role: "remove",
        params: { name: "RETIRED_FLAG" },
        drift: [
          "actions_variables[RETIRED_FLAG]: undeclared - not in the settings file, so apply will DELETE it; add it to the settings file to keep it",
        ],
        change: 'DELETED undeclared Actions variable "RETIRED_FLAG"',
        describe: 'deleting undeclared Actions variable "RETIRED_FLAG"',
      },
    ],
    notes: [],
    drift: [],
  };
  const undeclaredForms: Array<[string, Declared, Planned]> = [
    [
      "wrapped _undeclared: keep leaves it as a note, never a DELETE",
      { _undeclared: "keep", entries: converged },
      {
        ops: [],
        notes: [
          'Actions variable "RETIRED_FLAG" exists on the repo but is not declared in the settings file; kept under "_undeclared: keep" - add it to the settings file to manage it, or set "_undeclared: delete" to have apply DELETE it',
        ],
        drift: [],
      },
    ],
    [
      "the wrapper without a policy takes the delete default",
      { entries: converged },
      retiredFlagDeleted,
    ],
    [
      "an explicit _undeclared: delete plans the same deletion as the wrapper without a policy",
      { _undeclared: "delete", entries: converged },
      retiredFlagDeleted,
    ],
  ];
  test.each(undeclaredForms)("%s", async (_form, declared, expected) => {
    expect(await plan(new MockApi(listRoute(liveVariables)), declared)).toEqual(expected);
  });

  test("url-encodes tricky live names in the request path", async () => {
    // The parse refuses such a name in the settings file, so the tricky name is a LIVE one the file leaves undeclared.
    const api = new MockApi(listRoute([{ name: "ODD NAME", value: "x" }])).allowMutations(
      "DELETE /repos/o/r/actions/variables/*",
    );
    const { changes } = await apply(api, { _undeclared: "delete", entries: [] });
    expect(changes).toEqual(['DELETED undeclared Actions variable "ODD NAME"']);
    expect(api.mutations()[0]?.path).toBe("/repos/o/r/actions/variables/ODD%20NAME");
  });

  test("the list request asks for the endpoint's per-page cap and walks past a full page", async () => {
    // GitHub clamps this list's per_page silently, so a full first page must not end the walk: the second page proves the loop continues.
    const page1 = Array.from({ length: PAGE_SIZE }, (_, i) => ({ name: `VAR_${i}`, value: "x" }));
    const last = { name: `VAR_${PAGE_SIZE}`, value: "x" };
    const api = new MockApi({
      [`GET ${listPage(1)}`]: { data: { total_count: PAGE_SIZE + 1, variables: page1 } },
      [`GET ${listPage(2)}`]: { data: { total_count: PAGE_SIZE + 1, variables: [last] } },
    });
    const result = await plan(api, page1.concat([last]));
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
    expect(api.calls.map((c) => c.path)).toEqual([listPage(1), listPage(2)]);
  });

  test("a declared key the live variable does not carry drifts, and its update carries the phantom note", async () => {
    const api = new MockApi(listRoute([{ name: "DEPLOY_REGION", value: "us-east-1" }]));
    const result = await plan(api, [
      { name: "DEPLOY_REGION", value: "us-east-1", vaule: "typo" } as never,
    ]);
    expect(result.ops.map((op) => [op.role, op.payload, op.drift])).toEqual([
      [
        "update",
        { value: "us-east-1", vaule: "typo" },
        [
          'actions_variables[DEPLOY_REGION].vaule: declared "typo" but the API response has no such field (new or write-only field?)',
        ],
      ],
    ]);
    expect(result.notes).toEqual([
      expect.stringMatching(
        /actions_variables\[DEPLOY_REGION\]: declared key "vaule" does not exist on the live variable.*without converging/,
      ),
    ]);
  });
});
