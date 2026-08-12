/**
 * The `code_scanning_default_setup:` entry-config declaration. The root
 * src/schema.ts imports it and keeps the SettingsFile property wiring
 * (.optional()/.describe()) inline, re-exporting the config so existing
 * importers of src/schema.js keep compiling unchanged.
 */

import { z } from "zod";

export const CodeScanningDefaultSetupConfig = z
  .object({
    state: z
      .enum(["configured", "not-configured"])
      .optional()
      .describe('Turn default setup on ("configured") or off ("not-configured").'),
    query_suite: z.enum(["default", "extended"]).optional().describe("CodeQL query suite to run."),
    languages: z
      .array(z.string())
      .optional()
      .describe("Languages to scan, compared as a set; GitHub auto-detects when omitted."),
    runner_type: z
      .enum(["standard", "labeled"])
      .optional()
      .describe('Run on GitHub-hosted ("standard") or labeled self-hosted runners.'),
    runner_label: z
      .string()
      .nullable()
      .optional()
      .describe('Runner label when runner_type is "labeled"; null clears it.'),
    threat_model: z
      .enum(["remote", "remote_and_local"])
      .optional()
      .describe("Whether to model local sources as threats in addition to remote ones."),
  })
  .describe("PATCH /repos/{r}/code-scanning/default-setup, sent verbatim.")
  .meta({ id: "CodeScanningDefaultSetupConfig" });
export type CodeScanningDefaultSetupConfig = z.infer<typeof CodeScanningDefaultSetupConfig>;
