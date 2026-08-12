/**
 * `milestones:` section - upsert by title. Divergence from Probot:
 * undeclared milestones are kept by default (deleting a milestone detaches
 * it from every issue carrying it) and surfaced as notes. The wrapped
 * `undeclared: delete` form hardens that to deletion, detachment included.
 */

import { z } from "zod";
import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import type { EndpointDecl } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import {
  beginRun,
  defaultUndeclaredPolicy,
  loosen,
  type SectionModule,
  type SectionResult,
  undeclaredDrift,
  undeclaredNote,
  undeclaredPolicy,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { call, listAll, rejectDuplicates } from "../contract/requests.js";
import { knobbed } from "../shared/schema-helpers.js";
import { MilestoneConfig } from "./schema.js";

/** The fields of a live milestone this section reads; extras ride along. */
const LiveMilestone = z.looseObject({ number: z.number(), title: z.string() });

const permission: SectionPermission = { repo: ["issues"] };

const ENDPOINTS = {
  list: { route: "GET /repos/{owner}/{repo}/milestones", statuses: { 200: "the milestone list" } },
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

export const milestonesSection = {
  key: "milestones",
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(knobbed(MilestoneConfig)),
  async run(ctx, declared): Promise<SectionResult> {
    const run = beginRun(ctx);
    const { policy, entries: desired } = undeclaredPolicy(declared, defaultUndeclaredPolicy(this));
    rejectDuplicates(
      this,
      desired,
      (m) => m.title,
      (m) => m.title,
    );
    const live = parseLive(
      this,
      ENDPOINTS.list,
      z.array(LiveMilestone),
      await listAll(ctx, this, ENDPOINTS.list, { query: { state: "all" } }),
    );
    const liveByTitle = new Map(live.map((m) => [m.title, m]));
    const declaredKeys = new Set<string>();

    for (const milestone of desired) {
      declaredKeys.add(milestone.title);
      const existing = liveByTitle.get(milestone.title);
      // Declared-keys-only AND passthrough: every declared key (including
      // future ones like due_on) is sent verbatim; undeclared keys are
      // never touched.
      const want: Record<string, unknown> = { ...milestone };
      if (!existing) {
        if (run.check) {
          run.result.drift.push(
            `milestones[${milestone.title}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.create, { payload: want });
          run.result.changes.push(`created milestone "${milestone.title}"`);
        }
        continue;
      }
      const { title: _t, ...declaredFields } = milestone;
      const drift = subsetDiff(declaredFields, existing, `milestones[${milestone.title}]`);
      if (drift.length === 0) {
        continue;
      }
      if (run.check) {
        run.result.drift.push(...drift);
      } else {
        const phantom = phantomKeys(declaredFields, existing);
        if (phantom.length > 0) {
          run.result.notes.push(
            phantomNote(
              `milestones[${milestone.title}]`,
              phantom,
              "milestone",
              "this update will re-run",
            ),
          );
        }
        await call(ctx, this, ENDPOINTS.update, {
          params: { milestone_number: String(existing.number) },
          payload: want,
        });
        run.result.changes.push(`updated milestone "${milestone.title}"`);
      }
    }
    // Divergence from Probot: undeclared milestones are kept by default,
    // because deleting a milestone DETACHES it from every issue carrying it;
    // the wrapped `undeclared: delete` form opts into exactly that.
    for (const milestone of live) {
      if (declaredKeys.has(milestone.title)) {
        continue;
      }
      if (policy === "delete") {
        if (run.check) {
          run.result.drift.push(
            undeclaredDrift(defaultUndeclaredPolicy(this), {
              label: `milestones[${milestone.title}]`,
              action: "DELETE it, detaching it from every issue that carries it",
            }),
          );
        } else {
          await call(ctx, this, ENDPOINTS.remove, {
            params: { milestone_number: String(milestone.number) },
            describe: `deleting undeclared milestone "${milestone.title}"`,
          });
          run.result.changes.push(
            `DELETED undeclared milestone "${milestone.title}" (detached from every issue that carried it)`,
          );
        }
        continue;
      }
      run.result.notes.push(
        undeclaredNote({
          subject: `milestone "${milestone.title}"`,
          action:
            "DELETE it, detaching it from every issue that carries it (closing is not enough; closed milestones are still listed)",
        }),
      );
    }
    return run.result;
  },
} satisfies SectionModule<"milestones">;
