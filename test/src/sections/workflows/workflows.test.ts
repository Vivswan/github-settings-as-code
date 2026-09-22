import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "../../../../src/github/api.js";
import type { SectionInput } from "../../../../src/sections/contract/module.js";
import { planContext } from "../../../../src/sections/contract/plan.js";
import { workflowsSection } from "../../../../src/sections/workflows/index.js";
import { MockApi } from "../../../mock-api.js";
import { provePlanIdempotent } from "../../../sections/plan-idempotence.js";
import { REPO, unwrap } from "../../../sections/section-run.js";
import { validatedInput } from "../../../sections/validated-input.js";

/** A live workflow as the list endpoint returns it. */
interface LiveWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

/** A stateful fake of the workflows API, so a plan over executed state sees the converged repository. */
function liveRepo(workflows: LiveWorkflow[]): GitHubClient & { writes: string[] } {
  return {
    writes: [],
    async tryRequest(method, path) {
      if (method === "GET") {
        return { data: { total_count: workflows.length, workflows } };
      }
      const toggled = path.match(/\/actions\/workflows\/(\d+)\/(enable|disable)$/);
      const target = workflows.find((w) => String(w.id) === toggled?.[1]);
      if (toggled === null || target === undefined) {
        return { error: { status: 404, message: "Not Found", body: "" } };
      }
      target.state = toggled[2] === "enable" ? "active" : "disabled_manually";
      this.writes.push(`${method} ${path}`);
      return { data: null };
    },
    async tryGraphql() {
      throw new Error("the workflows section issues no GraphQL");
    },
  };
}

describe("workflows", () => {
  const liveWorkflows = {
    total_count: 3,
    workflows: [
      { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_inactivity" },
      { id: 3, name: "Gone", path: ".github/workflows/gone.yml", state: "deleted" },
    ],
  };
  const route = "GET /repos/o/r/actions/workflows?per_page=100&page=1";
  const plan = async (api: MockApi, desired: SectionInput<"workflows">) =>
    unwrap(
      await workflowsSection.plan(
        planContext(workflowsSection, api, REPO),
        validatedInput("workflows", desired),
      ),
    );

  test("plans one toggle per divergent workflow by live id, matching bare file names", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await plan(api, [
      { path: "ci.yml", state: "disabled" },
      { path: ".github/workflows/old.yml", state: "active" },
    ]);
    expect(result).toEqual({
      ops: [
        {
          role: "disable",
          params: { workflow_id: "1" },
          drift: [
            'workflows[ci.yml]: declared "disabled" != live "active"; apply will disable the workflow',
          ],
          change: 'disabled workflow ".github/workflows/ci.yml"',
        },
        {
          role: "enable",
          params: { workflow_id: "2" },
          drift: [
            'workflows[.github/workflows/old.yml]: declared "active" != live "disabled" (disabled_inactivity); apply will enable the workflow',
          ],
          change: 'enabled workflow ".github/workflows/old.yml"',
        },
      ],
      notes: [],
      drift: [],
    });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([route]);
  });

  test("a matching state plans nothing; undeclared workflows stay silent", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await plan(api, [{ path: "ci.yml", state: "active" }]);
    expect(result).toEqual({ ops: [], notes: [], drift: [] });
  });

  test("a declared path with no live workflow is op-less drift; a deleted live state counts as absent", async () => {
    const api = new MockApi({ [route]: { data: liveWorkflows } });
    const result = await plan(api, [
      { path: "nope.yml", state: "disabled" },
      { path: "gone.yml", state: "active" },
    ]);
    expect(result.ops).toEqual([]);
    expect(result.drift).toEqual([
      "workflows[nope.yml]: declared in the settings file but no workflow with that path exists on the repo, so apply skips it - create the workflow file, or remove it from the workflows section",
      "workflows[gone.yml]: declared in the settings file but no workflow with that path exists on the repo, so apply skips it - create the workflow file, or remove it from the workflows section",
    ]);
  });

  test("duplicate declarations for the same file under two spellings are a validate issue, so the document fails before any API call", () => {
    expect(
      workflowsSection.validate([
        { path: "ci.yml", state: "disabled" },
        { path: ".github/workflows/ci.yml", state: "active" },
      ]),
    ).toEqual([
      {
        path: "[1].path",
        message:
          '".github/workflows/ci.yml" names the same workflow as "ci.yml" declared earlier; keep exactly one entry per workflow',
      },
    ]);
  });

  test("an envelope without the expected list key is an actionable error", async () => {
    const api = new MockApi({ [route]: { data: { unexpected: true } } });
    await expect(plan(api, [{ path: "ci.yml", state: "active" }])).rejects.toThrow(
      /"workflows" list/,
    );
  });

  test("executing the plan converges: the re-plan over applied state is empty", async () => {
    const api = liveRepo([
      { id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" },
      { id: 2, name: "Old", path: ".github/workflows/old.yml", state: "disabled_inactivity" },
      { id: 3, name: "Gone", path: ".github/workflows/gone.yml", state: "deleted" },
    ]);
    const { first, second, changes } = await provePlanIdempotent(workflowsSection, api, [
      { path: "ci.yml", state: "disabled" },
      { path: "old.yml", state: "active" },
      { path: "gone.yml", state: "active" },
    ]);
    expect(changes).toEqual([
      'disabled workflow ".github/workflows/ci.yml"',
      'enabled workflow ".github/workflows/old.yml"',
    ]);
    expect(api.writes).toEqual([
      "PUT /repos/o/r/actions/workflows/1/disable",
      "PUT /repos/o/r/actions/workflows/2/enable",
    ]);
    // The unfixable finding (a "deleted" live workflow is absent) survives both plans unchanged.
    const gone =
      "workflows[gone.yml]: declared in the settings file but no workflow with that path exists on the repo, so apply skips it - create the workflow file, or remove it from the workflows section";
    expect(first.drift).toEqual([gone]);
    expect(second).toEqual({ ops: [], notes: [], drift: [gone] });
  });
});
