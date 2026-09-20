/** The `code_quality_setup:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";
import { languagesSchema, refineSetup, type SetupLanguages } from "../shared/setup-schema.js";

/** The PATCH's vocabulary; the GET also reports "rust", which has no declarable form. */
export const CODE_QUALITY_LANGUAGES = {
  declarable: ["csharp", "go", "java-kotlin", "javascript-typescript", "python", "ruby"],
  getOnly: { rust: null },
} as const satisfies SetupLanguages;

export const CodeQualitySetupConfig = z
  .object({
    state: z.enum(["configured", "not-configured"]).optional(),
    languages: languagesSchema(CODE_QUALITY_LANGUAGES).optional(),
    runner_type: z.enum(["standard", "labeled"]).optional(),
    runner_label: z.string().nullable().optional(),
    ai_findings_option: z.enum(["disabled", "on_push"]).optional(),
  })
  .superRefine(refineSetup)
  .meta({ id: "CodeQualitySetupConfig" });
export type CodeQualitySetupConfig = z.infer<typeof CodeQualitySetupConfig>;
