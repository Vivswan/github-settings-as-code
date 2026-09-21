/**
 * `workflows:` section: enable/disable existing workflows by path. A declared workflow whose file
 * does not exist is skipped loudly, never created: workflow files are code, not settings.
 */

import { z } from "zod";
import type { EndpointDecl } from "../contract/endpoints.js";
import { raise } from "../contract/errors.js";
import { liveByIdentity, liveIdentity } from "../contract/live.js";
import {
  keyedBy,
  listEntries,
  loosen,
  type SectionMeta,
  type SectionModule,
  valueDrift,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import type { PlannedOp, SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { layeredList } from "../shared/schema-helpers.js";
import { WorkflowsConfig } from "./schema.js";

const LiveWorkflow = z.looseObject({
  id: z.number(),
  path: z.string(),
  state: z.string(),
});
type LiveWorkflow = z.infer<typeof LiveWorkflow>;

/** A declared path as GitHub lists it: a bare file name lives under .github/workflows/. */
function workflowPath(declared: string): string {
  return declared.includes("/") ? declared : `.github/workflows/${declared}`;
}

/**
 * The workflows that still have a file, by path, under the duplicate-live guard; plan() and snapshot()
 * both index through it. A "deleted" workflow has no file behind it anymore, so it is absent.
 */
function workflowsByPath(
  section: SectionMeta,
  live: readonly LiveWorkflow[],
): Map<string, LiveWorkflow> {
  return raise(
    liveByIdentity(
      section,
      "workflow",
      live.filter((workflow) => workflow.state !== "deleted"),
      (workflow) => workflow.path,
      (workflow) => liveIdentity(workflow.path, { workflow_id: workflow.id }),
    ),
  );
}

const permission: SectionPermission = { repo: ["actions"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/actions/workflows",
    statuses: { 200: "the workflow list" },
    primaryRead: { notFound: "denied" },
  },
  enable: {
    route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable",
    statuses: { 204: "workflow enabled" },
  },
  disable: {
    route: "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable",
    statuses: { 204: "workflow disabled" },
  },
} as const satisfies Record<string, EndpointDecl>;

export const workflowsSection = {
  key: "workflows",
  undeclaredDefault: "untouched",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(layeredList(WorkflowsConfig)),
  // Folded as plan() folds a path: a bare file name and its .github/workflows/ spelling are one workflow.
  layering: keyedBy("path", { fold: workflowPath }),
  // The enable/disable PUTs carry no body at all, so an extra key can only be a typo that would silently do nothing.
  closedSurface: {
    known: { path: true, state: true },
    describe: (w) => w.path,
    consequence: "the enable/disable calls send no payload, so the key would silently do nothing",
  },
  async plan(ctx, desired) {
    const workflows = listEntries(desired);
    // Two entries naming the same file ("ci.yml" and ".github/workflows/ci.yml") would fight each other on every run.
    raise(
      rejectDuplicates(
        this,
        workflows,
        (w) => workflowPath(w.path),
        (w) => w.path,
      ),
    );
    const present = workflowsByPath(
      this,
      await ctx.read.list.listAllEnveloped("workflows", LiveWorkflow),
    );

    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    for (const workflow of workflows) {
      const match = present.get(workflowPath(workflow.path));
      if (!match) {
        // No operation can create a workflow file.
        plan.drift.push(
          `workflows[${workflow.path}]: declared in the settings file but no workflow with that path exists on the repo, so apply skips it - create the workflow file, or remove it from the workflows section`,
        );
        continue;
      }
      const liveState = match.state === "active" ? "active" : "disabled";
      if (liveState === workflow.state) {
        continue;
      }
      const action = workflow.state === "active" ? "enable" : "disable";
      plan.ops.push({
        role: action,
        params: { workflow_id: String(match.id) },
        drift: [
          valueDrift(
            `workflows[${workflow.path}]`,
            JSON.stringify(workflow.state),
            JSON.stringify(liveState),
            {
              qualifier: match.state === liveState ? undefined : match.state,
              remedy: `apply will ${action} the workflow`,
            },
          ),
        ],
        change: `${action}d workflow "${match.path}"`,
      });
    }
    return plan;
  },
  // Every disabled_* live state reads back as "disabled", the effective state apply compares; a
  // "deleted" workflow has no file and would only plan as unfixable drift, so it is left out.
  async snapshot(ctx) {
    const present = [
      ...workflowsByPath(
        this,
        await ctx.read.list.listAllEnveloped("workflows", LiveWorkflow),
      ).values(),
    ];
    if (present.length === 0) {
      return { value: undefined, notes: [] };
    }
    return {
      value: present.map((w) => ({
        path: w.path,
        state: w.state === "active" ? ("active" as const) : ("disabled" as const),
      })),
      notes: [],
    };
  },
} satisfies SectionModule<"workflows", typeof ENDPOINTS>;
