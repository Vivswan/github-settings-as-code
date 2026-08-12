/**
 * `code_quality_setup:` section - PATCH the code quality setup
 * configuration; a 409 (configuration run in progress) gets its own advice.
 * A near mirror of code_scanning_default_setup: both PATCH verbatim, both
 * compare declared keys only through subsetDiff (whose scalar-list branch
 * compares `languages` as a set), and both name the 202 configuration run.
 */

import { subsetDiff } from "../../engine/diff.js";
import {
  beginRun,
  call,
  type EndpointDecl,
  expand,
  loosen,
  requirePlainMapping,
  type SectionModule,
  type SectionPermission,
  type SectionResult,
  tryCall,
} from "../contract.js";
import { CodeQualitySetupConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["administration"] };

const ENDPOINTS = {
  get: {
    route: "GET /repos/{owner}/{repo}/code-quality/setup",
    statuses: { 200: "the current code quality setup configuration" },
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

export const codeQualitySetupSection = {
  key: "code_quality_setup",
  undeclaredDefault: "untouched",
  permission,
  grantCaveat:
    "a 403 on this endpoint can also mean code quality is unavailable on the repository, or the repository is archived",
  endpoints: ENDPOINTS,
  shape: requirePlainMapping(loosen(CodeQualitySetupConfig)),
  async run(ctx, declared): Promise<SectionResult> {
    const run = beginRun(ctx);
    const desired: Record<string, unknown> = declared;

    if (run.check) {
      const live = await call(ctx, this, ENDPOINTS.get);
      run.result.drift.push(...subsetDiff(desired, live, "code_quality_setup"));
      return run.result;
    }

    // Tolerate a 409 (a configuration run is already in progress) so it
    // gets accurate advice instead of throwFor's generic fix-the-file text;
    // 409 is a declared status of this endpoint, so it is tolerated by default.
    const patch = await tryCall(ctx, this, ENDPOINTS.update, { payload: desired });
    if ("error" in patch) {
      throw new Error(
        `code_quality_setup: PATCH ${expand(ENDPOINTS.update, ctx)}: ${patch.error.status} ${patch.error.message}. A code quality configuration run is already in progress on the repository; re-run the workflow after it finishes`,
      );
    }
    const configurationRun = patch.data as { run_id?: number; run_url?: string } | null;
    if (configurationRun?.run_id !== undefined) {
      const url = configurationRun.run_url ? ` (${configurationRun.run_url})` : "";
      run.result.changes.push(
        `applied code quality setup; GitHub started configuration run ${configurationRun.run_id}${url} to roll it out, and the settings take effect when it finishes`,
      );
    } else {
      run.result.changes.push("applied code quality setup");
    }
    return run.result;
  },
} satisfies SectionModule<"code_quality_setup">;
