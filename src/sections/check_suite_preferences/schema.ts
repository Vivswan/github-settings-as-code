/**
 * The `check_suite_preferences:` entry-config declaration and its
 * AutoTriggerCheckConfig helper. The root src/schema.ts imports the config
 * and keeps the SettingsFile property wiring (.optional()/.describe())
 * inline, re-exporting both so existing importers of src/schema.js keep
 * compiling unchanged.
 */

import { z } from "zod";

export const AutoTriggerCheckConfig = z
  .object({
    app_id: z.int().describe("The id of the GitHub App the preference applies to."),
    setting: z
      .boolean()
      .describe(
        "Whether pushes automatically create check suites for this app; GitHub defaults each app to true.",
      ),
  })
  .describe("One per-app auto-trigger toggle. Extra fields pass through verbatim.")
  .meta({ id: "AutoTriggerCheckConfig" });
export type AutoTriggerCheckConfig = z.infer<typeof AutoTriggerCheckConfig>;

export const CheckSuitePreferencesConfig = z
  .looseObject({
    auto_trigger_checks: z
      .array(AutoTriggerCheckConfig)
      .describe("Per-app toggles for whether pushes automatically create check suites."),
  })
  .catchall(z.unknown().describe("Future preference fields pass through verbatim."))
  .describe(
    "PATCH /repos/{r}/check-suites/preferences, sent verbatim. Write-only upstream: GitHub exposes no read endpoint for these preferences, so check mode cannot verify them and apply re-asserts the declared preferences on every run.",
  )
  .meta({ id: "CheckSuitePreferencesConfig" });
export type CheckSuitePreferencesConfig = z.infer<typeof CheckSuitePreferencesConfig>;
