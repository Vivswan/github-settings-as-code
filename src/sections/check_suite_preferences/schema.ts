/** The `check_suite_preferences:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";
import { isMapping } from "../shared/raw-values.js";

// No GitHub App has id 0, and GitHub rejects fractions. Parse refuses the id here; otherwise the PATCH reports whatever
// GitHub answers, late and on every run. The duplicate below is the case nothing would ever report.
const APP_ID_RULE =
  "a GitHub App id is a positive integer (the App's settings page shows it); GitHub has no app 0 and rejects fractions";
const AppId = z.int(APP_ID_RULE).positive(APP_ID_RULE);

const AutoTriggerCheckConfig = z
  .object({
    app_id: AppId,
    setting: z.boolean(),
  })
  .meta({ id: "AutoTriggerCheckConfig" });

export const CheckSuitePreferencesConfig = z
  .looseObject({
    auto_trigger_checks: z.array(AutoTriggerCheckConfig),
  })
  .catchall(z.unknown())
  .superRefine((declared, refineCtx) => {
    // GitHub keeps whichever entry for an app it reads last, on every run, and no read endpoint exists to show the other
    // one lost; the file contradicts itself, so the pair is refused here. An entry whose app_id failed the bound still
    // arrives (zod continues past it), so a document with both faults reports both. The list or an entry may be raw
    // beside its own shape issue (see ../shared/raw-values.ts): a non-list holds no entries, and an entry without a
    // numeric app_id names no app.
    const firstAt = new Map<number, number>();
    const entries: unknown = declared.auto_trigger_checks;
    (Array.isArray(entries) ? entries : []).forEach((entry: unknown, index) => {
      if (!isMapping(entry) || typeof entry.app_id !== "number") {
        return;
      }
      const { app_id } = entry;
      const first = firstAt.get(app_id);
      if (first === undefined) {
        firstAt.set(app_id, index);
        return;
      }
      refineCtx.addIssue({
        code: "custom",
        path: ["auto_trigger_checks", index, "app_id"],
        message: `repeats app_id ${app_id} from auto_trigger_checks[${first}]; GitHub would keep whichever entry it reads last and nothing reads the result back, so declare one entry per app`,
      });
    });
  })
  .meta({ id: "CheckSuitePreferencesConfig" });
export type CheckSuitePreferencesConfig = z.infer<typeof CheckSuitePreferencesConfig>;
