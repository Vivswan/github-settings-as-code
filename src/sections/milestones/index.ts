/**
 * `milestones:` section - upsert by title. Divergence from Probot:
 * undeclared milestones are kept by default (deleting a milestone detaches
 * it from every issue carrying it) and surfaced as notes. The wrapped
 * `undeclared: delete` form hardens that to deletion, detachment included.
 */

import { z } from "zod";
import { deltas, phantomKeys, phantomNote, renderDelta } from "../../engine/diff.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  defaultUndeclaredPolicy,
  loosen,
  type SectionModule,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { hasDrift, type PlannedOp, plainData, type SectionPlan } from "../contract/plan.js";
import { rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "../shared/schema-helpers.js";
import { MilestoneConfig } from "./schema.js";

/** The fields of a live milestone this section reads; extras ride along. */
const LiveMilestone = z.looseObject({ number: z.number(), title: z.string() });

const permission: SectionPermission = { repo: ["issues"] };

const ENDPOINTS = {
  list: {
    route: "GET /repos/{owner}/{repo}/milestones",
    statuses: { 200: "the milestone list" },
    primaryRead: { notFound: "denied" },
  },
  create: {
    route: "POST /repos/{owner}/{repo}/milestones",
    statuses: { 201: "milestone created" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/milestones/{milestone_number}",
    statuses: { 200: "milestone updated" },
  },
  remove: {
    route: "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}",
    statuses: { 204: "milestone deleted" },
  },
} as const satisfies Record<string, EndpointDecl>;

/** Deleting a milestone detaches it from its issues; every undeclared-delete line says so. */
const DETACH_ACTION = "DELETE it, detaching it from every issue that carries it";

export const milestonesSection = {
  key: "milestones",
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(knobbed(MilestoneConfig)),
  async plan(ctx, declared) {
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    rejectDuplicates(
      this,
      desired,
      (m) => m.title,
      (m) => m.title,
    );
    // Closed milestones are still listed under state=all; the default listing
    // omits them, and a declared closed milestone would read as missing.
    const live = parseLive(
      this,
      ENDPOINTS.list,
      z.array(LiveMilestone),
      await ctx.read.list.listAll({ query: { state: "all" } }),
    );
    const liveByTitle = new Map(live.map((m) => [m.title, m]));
    const declaredKeys = new Set<string>();

    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    for (const milestone of desired) {
      declaredKeys.add(milestone.title);
      const label = `milestones[${milestone.title}]`;
      const existing = liveByTitle.get(milestone.title);
      // Every declared key (including ones this schema does not name) is sent verbatim.
      const payload = plainData({ ...milestone });
      if (existing === undefined) {
        plan.ops.push({
          role: "create",
          payload,
          describe: `creating milestone "${milestone.title}"`,
          drift: [
            `${label}: missing - declared in the settings file but not on the repo; apply will create it`,
          ],
          change: `created milestone "${milestone.title}"`,
        });
        continue;
      }
      const { title: _t, ...declaredFields } = milestone;
      const drift = deltas(declaredFields, existing, { matchBy: {} }).map((delta) =>
        renderDelta(label, delta),
      );
      if (!hasDrift(drift)) {
        continue;
      }
      const phantom = phantomKeys(declaredFields, existing);
      if (phantom.length > 0) {
        plan.notes.push(phantomNote(label, phantom, "milestone", "this update will re-run"));
      }
      plan.ops.push({
        role: "update",
        params: { milestone_number: String(existing.number) },
        payload,
        describe: `updating milestone "${milestone.title}"`,
        drift,
        change: `updated milestone "${milestone.title}"`,
      });
    }

    for (const milestone of live) {
      if (declaredKeys.has(milestone.title)) {
        continue;
      }
      if (policy === "delete") {
        plan.ops.push({
          role: "remove",
          params: { milestone_number: String(milestone.number) },
          describe: `deleting undeclared milestone "${milestone.title}"`,
          drift: [
            undeclaredDrift(defaultUndeclaredPolicy(this), {
              label: `milestones[${milestone.title}]`,
              action: DETACH_ACTION,
            }),
          ],
          change: `DELETED undeclared milestone "${milestone.title}" (detached from every issue that carried it)`,
        });
        continue;
      }
      plan.notes.push(
        undeclaredNote({
          subject: `milestone "${milestone.title}"`,
          action: `${DETACH_ACTION} (closing is not enough; closed milestones are still listed)`,
        }),
      );
    }
    return plan;
  },
} satisfies SectionModule<"milestones", typeof ENDPOINTS>;
