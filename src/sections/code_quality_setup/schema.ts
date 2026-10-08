/** The `code_quality_setup:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import type { components } from "@octokit/openapi-types";
import { z } from "zod";
import {
  CODE_QUALITY_AI_FINDINGS_OPTIONS,
  CODE_QUALITY_RUNNER_TYPES,
  CODE_QUALITY_STATES,
} from "../../generated/spec-enums.js";
import type { MustBeNever } from "../../types.js";
import { open, rule } from "../shared/schema-helpers.js";
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

export const CodeQualitySetupConfig = open({
  state: z.enum(CODE_QUALITY_STATES).optional(),
  languages: languagesSchema(CODE_QUALITY_LANGUAGES).optional(),
  runner_type: z.enum(CODE_QUALITY_RUNNER_TYPES).optional(),
  runner_label: z.string().nullable().optional(),
  ai_findings_option: z.enum(CODE_QUALITY_AI_FINDINGS_OPTIONS).optional(),
})
  .check(rule(refineSetup))
  .meta({ id: "CodeQualitySetupConfig" });
export type CodeQualitySetupConfig = z.infer<typeof CodeQualitySetupConfig>;
