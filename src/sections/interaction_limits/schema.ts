/** The `interaction_limits:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";
import type { MustBeNever } from "../../types.js";

// Shared by the shape's base-key sweep below and the handler's strip. Pinned to the config type
// after the schema (_RoutedKeysReal), so a typo'd or renamed key fails to compile instead of
// silently riding the base PUT.
const ROUTED_KEY_LIST = ["pull_request_creation_cap", "pull_request_creation_bypass"] as const;
export const INTERACTION_LIMITS_ROUTED_KEYS: ReadonlySet<string> = new Set(ROUTED_KEY_LIST);

// Not exported: consumers spell it NonNullable<InteractionLimitsConfig>. The definition id stays
// "InteractionLimitsConfig"; moving it onto the nullable wrapper would change the published schema.
const InteractionLimits = z
  .object({
    limit: z.string().optional(),
    expiry: z.string().optional(),
    // The cap object IS the PATCH body, open so future fields ride it; the flag is typed so a
    // YAML-quoted "true" fails upfront in document validation, before any section writes.
    pull_request_creation_cap: z
      .object({
        enabled: z.boolean({
          error:
            'enabled must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the cap direction is unambiguous',
        }),
        max_open_pull_requests: z.number().optional(),
      })
      .optional(),
    pull_request_creation_bypass: z.array(z.string()).optional(),
  })
  .superRefine((declared, refineCtx) => {
    // Checked in the shape so both modes fail before ANY section writes. Base keys are read off the
    // parsed record because only the loosen()ed clone, which keeps unknown keys, ever parses documents.
    const record = declared as Record<string, unknown>;
    const baseKeys = Object.keys(record).filter((key) => !INTERACTION_LIMITS_ROUTED_KEYS.has(key));
    if (
      baseKeys.length === 0 &&
      record.pull_request_creation_cap === undefined &&
      record.pull_request_creation_bypass === undefined
    ) {
      refineCtx.addIssue({
        code: "custom",
        message:
          "declare at least one of limit, pull_request_creation_cap, or pull_request_creation_bypass (or declare interaction_limits: null to clear the base limit)",
      });
    }
    if (baseKeys.length > 0 && record.limit === undefined) {
      // GitHub rejects the base PUT body without a limit, and a run that never issues the PUT would
      // silently drop the other base keys.
      refineCtx.addIssue({
        code: "custom",
        path: ["limit"],
        message: `key(s) [${baseKeys.join(", ")}] ride the base interaction-limits PUT, which requires a limit; declare limit alongside them, or remove them`,
      });
    }
    const bypass = record.pull_request_creation_bypass;
    if (!Array.isArray(bypass)) {
      return;
    }
    if (bypass.length > 100) {
      // GitHub caps the list itself at 100, and 100 is also what makes single-request reconciliation
      // valid: the writes take at most 100 users per request.
      refineCtx.addIssue({
        code: "custom",
        path: ["pull_request_creation_bypass"],
        message: `GitHub caps the bypass list at 100 users, but ${bypass.length} logins are declared; trim the list`,
      });
    }
    const seen = new Map<string, string>();
    for (const login of bypass as string[]) {
      const key = login.toLowerCase();
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, login);
      } else {
        refineCtx.addIssue({
          code: "custom",
          path: ["pull_request_creation_bypass"],
          message: `"${first}" and "${login}" name the same login (logins are case-insensitive); keep exactly one`,
        });
      }
    }
  })
  .meta({ id: "InteractionLimitsConfig" });

export const InteractionLimitsConfig = InteractionLimits.nullable();
export type InteractionLimitsConfig = z.infer<typeof InteractionLimitsConfig>;

type _RoutedKeysReal = MustBeNever<
  Exclude<(typeof ROUTED_KEY_LIST)[number], keyof NonNullable<InteractionLimitsConfig>>
>;
