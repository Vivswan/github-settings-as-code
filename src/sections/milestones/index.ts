/**
 * `milestones:` section - upsert by title. Divergence from Probot:
 * undeclared milestones are kept by default (deleting a milestone detaches
 * it from every issue carrying it) and surfaced as notes. The wrapped
 * `undeclared: delete` form hardens that to deletion, detachment included.
 */

import { phantomKeys, phantomNote, subsetDiff } from "../../engine/diff.js";
import { type MilestoneConfig, SettingsFile, type UndeclaredPolicyList } from "../../schema.js";
import {
  call,
  defaultUndeclaredPolicy,
  type EndpointDecl,
  emptyResult,
  listAll,
  loosen,
  rejectDuplicates,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  undeclaredPolicy,
} from "../contract.js";

interface LiveMilestone {
  number: number;
  title: string;
  description: string | null;
  state: string;
}

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

export const milestonesSection: SectionModule<"milestones"> = {
  key: "milestones",
  undeclaredDefault: "keep",
  permission,
  endpoints: ENDPOINTS,
  shape: loosen(SettingsFile.shape.milestones),
  async run(ctx, desiredRaw): Promise<SectionResult> {
    const result = emptyResult();
    const { policy, entries: desired } = undeclaredPolicy(
      desiredRaw as MilestoneConfig[] | UndeclaredPolicyList<MilestoneConfig>,
      defaultUndeclaredPolicy(this),
    );
    rejectDuplicates(
      this,
      desired,
      (m) => m.title,
      (m) => m.title,
    );
    const live = (await listAll(ctx, this, ENDPOINTS.list, {
      query: { state: "all" },
    })) as LiveMilestone[];
    const liveByTitle = new Map(live.map((m) => [m.title, m]));
    const declared = new Set<string>();

    for (const milestone of desired) {
      declared.add(milestone.title);
      const existing = liveByTitle.get(milestone.title);
      // Declared-keys-only AND passthrough: every declared key (including
      // future ones like due_on) is sent verbatim; undeclared keys are
      // never touched.
      const want: Record<string, unknown> = { ...milestone };
      if (!existing) {
        if (ctx.check) {
          result.drift.push(
            `milestones[${milestone.title}]: missing - declared in the settings file but not on the repo; apply will create it`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.create, { payload: want });
          result.changes.push(`created milestone "${milestone.title}"`);
        }
        continue;
      }
      const { title: _t, ...declaredFields } = milestone;
      const drift = subsetDiff(declaredFields, existing, `milestones[${milestone.title}]`);
      if (drift.length === 0) {
        continue;
      }
      if (ctx.check) {
        result.drift.push(...drift);
      } else {
        const phantom = phantomKeys(declaredFields, existing);
        if (phantom.length > 0) {
          result.notes.push(
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
        result.changes.push(`updated milestone "${milestone.title}"`);
      }
    }
    // Divergence from Probot: undeclared milestones are kept by default,
    // because deleting a milestone DETACHES it from every issue carrying it;
    // the wrapped `undeclared: delete` form opts into exactly that.
    for (const milestone of live) {
      if (declared.has(milestone.title)) {
        continue;
      }
      if (policy === "delete") {
        if (ctx.check) {
          result.drift.push(
            `milestones[${milestone.title}]: undeclared - not in the settings file and "undeclared: delete" is set, so apply will DELETE it, detaching it from every issue that carries it; add it to the settings file to keep it`,
          );
        } else {
          await call(ctx, this, ENDPOINTS.remove, {
            params: { milestone_number: String(milestone.number) },
            describe: `deleting undeclared milestone "${milestone.title}"`,
          });
          result.changes.push(
            `DELETED undeclared milestone "${milestone.title}" (detached from every issue that carried it)`,
          );
        }
        continue;
      }
      result.notes.push(
        `milestone "${milestone.title}" exists on the repo but is not declared in the settings file; kept under "undeclared: keep" - add it to the settings file to manage it, or set "undeclared: delete" to have apply DELETE it, detaching it from every issue that carries it (closing is not enough; closed milestones are still listed)`,
      );
    }
    return result;
  },
};
