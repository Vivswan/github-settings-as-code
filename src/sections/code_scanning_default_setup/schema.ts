/** The `code_scanning_default_setup:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import type { components } from "@octokit/openapi-types";
import { z } from "zod";
import type { MustBeNever } from "../../types.js";
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

export const CodeScanningDefaultSetupConfig = z
  .object({
    state: z.enum(["configured", "not-configured"]).optional(),
    query_suite: z.enum(["default", "extended"]).optional(),
    languages: languagesSchema(CODE_SCANNING_LANGUAGES).optional(),
    runner_type: z.enum(["standard", "labeled"]).optional(),
    runner_label: z.string().nullable().optional(),
    threat_model: z.enum(["remote", "remote_and_local"]).optional(),
  })
  .superRefine(refineSetup)
  .meta({ id: "CodeScanningDefaultSetupConfig" });
export type CodeScanningDefaultSetupConfig = z.infer<typeof CodeScanningDefaultSetupConfig>;
