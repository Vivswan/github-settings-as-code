/** The `code_quality_setup:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import type { components } from "@octokit/openapi-types";
import { z } from "zod";
import type { MustBeNever } from "../../types.js";
import {
  languagesSchema,
  refineSetup,
  type SetupLanguages,
  type VocabularyDrift,
} from "../shared/setup-schema.js";

/** The PATCH's vocabulary; the GET also reports "rust", which has no declarable form. */
export const CODE_QUALITY_LANGUAGES = {
  declarable: ["csharp", "go", "java-kotlin", "javascript-typescript", "python", "ruby"],
  getOnly: { rust: null },
} as const satisfies SetupLanguages;
type _VocabularyIsTheVendoredSpec = MustBeNever<
  VocabularyDrift<
    typeof CODE_QUALITY_LANGUAGES,
    components["schemas"]["code-quality-setup"],
    components["schemas"]["code-quality-setup-update"]
  >
>;

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
