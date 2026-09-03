/**
 * `code_quality_setup:` section - PATCH the code quality setup
 * configuration; a 409 (configuration run in progress) gets its own advice.
 * A near mirror of code_scanning_default_setup: both PATCH verbatim, both
 * compare declared keys only through subsetDiff (whose scalar-list branch
 * compares `languages` as a set), and both name the 202 configuration run.
 */

import { z } from "zod";
import { subsetDiff } from "../../engine/diff.js";
import { type EndpointDecl, expand } from "../contract/endpoints.js";
import { parseLive } from "../contract/live.js";
import { loosen, requirePlainMapping, type SectionModule } from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { hasDrift, type PlannedOp, plainData, type SectionPlan } from "../contract/plan.js";
import { CodeQualitySetupConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  // GitHub gates this READ at write (the Codespaces secrets precedent), so a
  // read-only token is denied it.
  get: {
    route: "GET /repos/{owner}/{repo}/code-quality/setup",
    statuses: { 200: "the current code quality setup configuration" },
    primaryRead: { notFound: "denied" },
    accessGrade: "write",
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/code-quality/setup",
    statuses: {
      200: "setup updated",
      202: "GitHub started an async configuration run; the body carries run_id",
      409: "a configuration run is already in progress",
    },
  },
} as const satisfies Record<string, EndpointDecl>;

/**
 * The PATCH answer's fields this section reads: the 202 body's async
 * configuration run, both fields absent on a plain 200 (whose body is the
 * setup object). Nullish covers an empty body.
 */
const LiveConfigurationRun = z
  .looseObject({ run_id: z.number().optional(), run_url: z.string().optional() })
  .nullish();

export const codeQualitySetupSection = {
  key: "code_quality_setup",
  undeclaredDefault: "untouched",
  permission,
  grantCaveat:
    "a 403 on this endpoint can also mean code quality is unavailable on the repository, or the repository is archived",
  endpoints: ENDPOINTS,
  shape: requirePlainMapping(loosen(CodeQualitySetupConfig)),
  async plan(ctx, declared) {
    const desired: Record<string, unknown> = declared;
    const plan: SectionPlan<PlannedOp<typeof ENDPOINTS>> = { ops: [], notes: [], drift: [] };
    const drift = subsetDiff(desired, await ctx.read.get.call(), "code_quality_setup");
    if (hasDrift(drift)) {
      plan.ops.push({
        role: "update",
        payload: plainData(desired),
        drift,
        // A 409 (a configuration run is already in progress) gets accurate
        // advice instead of throwFor's generic fix-the-file text; it is a
        // declared status of this endpoint, so the tolerance can name it.
        tolerate: {
          statuses: [409],
          outcome: (error) => ({
            failure: `code_quality_setup: PATCH ${expand(ENDPOINTS.update, ctx)}: ${error.status} ${error.message}. A code quality configuration run is already in progress on the repository; re-run the workflow after it finishes`,
          }),
        },
        change: (response) => {
          const configurationRun = parseLive(
            this,
            ENDPOINTS.update,
            LiveConfigurationRun,
            response,
          );
          if (configurationRun?.run_id === undefined) {
            return "applied code quality setup";
          }
          const url = configurationRun.run_url ? ` (${configurationRun.run_url})` : "";
          return `applied code quality setup; GitHub started configuration run ${configurationRun.run_id}${url} to roll it out, and the settings take effect when it finishes`;
        },
      });
    }
    return plan;
  },
} satisfies SectionModule<"code_quality_setup", typeof ENDPOINTS>;
