/**
 * The `code_quality_setup:` entry-config declaration. The root src/schema.ts
 * imports it and keeps the SettingsFile property wiring
 * (.optional()/.describe()) inline, re-exporting the config so existing
 * importers of src/schema.js keep compiling unchanged.
 */

import { z } from "zod";

export const CodeQualitySetupConfig = z
  .object({
    state: z
      .enum(["configured", "not-configured"])
      .optional()
      .describe('Turn code quality analysis on ("configured") or off ("not-configured").'),
    languages: z
      .array(z.string())
      .optional()
      .describe("Languages to analyze, compared as a set; GitHub auto-detects when omitted."),
    runner_type: z
      .enum(["standard", "labeled"])
      .optional()
      .describe('Run on GitHub-hosted ("standard") or labeled self-hosted runners.'),
    runner_label: z
      .string()
      .nullable()
      .optional()
      .describe('Runner label when runner_type is "labeled"; null clears it.'),
    ai_findings_option: z
      .enum(["disabled", "on_push"])
      .optional()
      .describe(
        'AI-powered findings: "on_push" runs them on every push, "disabled" turns them off.',
      ),
  })
  .describe("PATCH /repos/{r}/code-quality/setup, sent verbatim.")
  .meta({ id: "CodeQualitySetupConfig" });
export type CodeQualitySetupConfig = z.infer<typeof CodeQualitySetupConfig>;
