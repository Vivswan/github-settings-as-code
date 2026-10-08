/** The `code_scanning_default_setup:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import type { components } from "@octokit/openapi-types";
import { z } from "zod";
import {
  CODE_SCANNING_QUERY_SUITES,
  CODE_SCANNING_RUNNER_TYPES,
  CODE_SCANNING_STATES,
  CODE_SCANNING_THREAT_MODELS,
} from "../../generated/spec-enums.js";
import type { MustBeNever } from "../../types.js";
import { open, rule } from "../shared/schema-helpers.js";
import {
  languagesSchema,
  refineSetup,
  type SetupLanguages,
  type VocabularyDrift,
} from "../shared/setup-schema.js";

/** The PATCH's vocabulary; the GET still spells JavaScript and TypeScript apart, and both fold onto the pair. */
export const CODE_SCANNING_LANGUAGES = {
  declarable: [
    "actions",
    "c-cpp",
    "csharp",
    "go",
    "java-kotlin",
    "javascript-typescript",
    "python",
    "ruby",
    "swift",
  ],
  getOnly: { javascript: "javascript-typescript", typescript: "javascript-typescript" },
} as const satisfies SetupLanguages;
type _VocabularyIsTheVendoredSpec = MustBeNever<
  VocabularyDrift<
    typeof CODE_SCANNING_LANGUAGES,
    components["schemas"]["code-scanning-default-setup"],
    components["schemas"]["code-scanning-default-setup-update"]
  >
>;

export const CodeScanningDefaultSetupConfig = open({
  state: z.enum(CODE_SCANNING_STATES).optional(),
  query_suite: z.enum(CODE_SCANNING_QUERY_SUITES).optional(),
  languages: languagesSchema(CODE_SCANNING_LANGUAGES).optional(),
  runner_type: z.enum(CODE_SCANNING_RUNNER_TYPES).optional(),
  runner_label: z.string().nullable().optional(),
  threat_model: z.enum(CODE_SCANNING_THREAT_MODELS).optional(),
})
  .check(rule(refineSetup))
  .meta({ id: "CodeScanningDefaultSetupConfig" });
export type CodeScanningDefaultSetupConfig = z.infer<typeof CodeScanningDefaultSetupConfig>;
