/**
 * `code_scanning_default_setup:` section - PATCH the default-setup
 * configuration; a 409 (configuration run in progress) gets its own advice.
 */

import { subsetDiff } from "../../engine/diff.js";
import { type EndpointDecl, expand } from "../contract/endpoints.js";
import {
  beginRun,
  loosen,
  requirePlainMapping,
  type SectionModule,
  type SectionResult,
} from "../contract/module.js";
import type { SectionPermission } from "../contract/permissions.js";
import { call, tryCall } from "../contract/requests.js";
import { CodeScanningDefaultSetupConfig } from "./schema.js";

const permission: SectionPermission = { repo: ["administration", "code_scanning_alerts"] };

const ENDPOINTS = {
  get: {
    route: "GET /repos/{owner}/{repo}/code-scanning/default-setup",
    statuses: { 200: "the current default-setup configuration" },
  },
  update: {
    route: "PATCH /repos/{owner}/{repo}/code-scanning/default-setup",
    statuses: {
      200: "setup updated",
      202: "GitHub started an async configuration run; the body carries run_id",
      409: "a configuration validation run is already in progress",
    },
  },
} as const satisfies Record<string, EndpointDecl>;

export const codeScanningDefaultSetupSection = {
  key: "code_scanning_default_setup",
  undeclaredDefault: "untouched",
  permission,
  grantCaveat:
    "a 403 on this endpoint can also mean GitHub Advanced Security (code security) is not enabled on the repository, or the repository is archived",
  endpoints: ENDPOINTS,
  shape: requirePlainMapping(loosen(CodeScanningDefaultSetupConfig)),
  async run(ctx, declared): Promise<SectionResult> {
    const run = beginRun(ctx);
    const desired: Record<string, unknown> = declared;

    if (run.check) {
      const live = await call(ctx, this, ENDPOINTS.get);
      run.result.drift.push(...subsetDiff(desired, live, "code_scanning_default_setup"));
      return run.result;
    }

    // Tolerate a 409 (a configuration run is already in progress) so it
    // gets accurate advice instead of throwFor's generic fix-the-file text;
    // 409 is a declared status of this endpoint, so it is tolerated by default.
    const patch = await tryCall(ctx, this, ENDPOINTS.update, { payload: desired });
    if ("error" in patch) {
      throw new Error(
        `code_scanning_default_setup: PATCH ${expand(ENDPOINTS.update, ctx)}: ${patch.error.status} ${patch.error.message}. A default-setup configuration run is already in progress on the repository; re-run the workflow after it finishes`,
      );
    }
    const configurationRun = patch.data as { run_id?: number; run_url?: string } | null;
    if (configurationRun?.run_id !== undefined) {
      const url = configurationRun.run_url ? ` (${configurationRun.run_url})` : "";
      run.result.changes.push(
        `applied code scanning default setup; GitHub started configuration run ${configurationRun.run_id}${url} to roll it out, and the settings take effect when it finishes`,
      );
    } else {
      run.result.changes.push("applied code scanning default setup");
    }
    return run.result;
  },
} satisfies SectionModule<"code_scanning_default_setup">;
