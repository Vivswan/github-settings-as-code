/** The `interaction_limits:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";
import { agree } from "../../text.js";

const INTERACTION_GROUPS = ["existing_users", "contributors_only", "collaborators_only"] as const;
const INTERACTION_EXPIRIES = [
  "one_day",
  "three_days",
  "one_week",
  "one_month",
  "six_months",
] as const;

const LIMIT_RULE = `limit is one of ${INTERACTION_GROUPS.join(", ")} (GitHub's interaction groups)`;
const EXPIRY_RULE = `expiry is one of ${INTERACTION_EXPIRIES.join(", ")} (GitHub's interaction durations)`;
const CAP_RULE = "max_open_pull_requests is a whole number from 1 to 1000 (GitHub's range)";

// GitHub reads the base limit back as limit, origin, and expires_at; the last two are never accepted, and an
// expires_at declared here would compare unequal on every run.
const KNOWN_KEYS =
  "interaction_limits takes limit, expiry, pull_request_creation_cap, and pull_request_creation_bypass " +
  "(origin and expires_at are what GitHub reports, not what it accepts); remove the key, or fix its spelling";

function unknownKeyError(issue: z.core.$ZodRawIssue): string | undefined {
  if (issue.code !== "unrecognized_keys") {
    return undefined;
  }
  const keys = issue.keys.map((key) => JSON.stringify(key)).join(", ");
  return `${agree(issue.keys.length, "Unrecognized key", "Unrecognized keys")}: ${keys}; ${KNOWN_KEYS}`;
}

// Not exported: consumers spell it NonNullable<InteractionLimitsConfig>. The definition id stays
// "InteractionLimitsConfig"; moving it onto the nullable wrapper would change the published schema.
const InteractionLimits = z
  .strictObject(
    {
      limit: z.enum(INTERACTION_GROUPS, { error: LIMIT_RULE }).optional(),
      expiry: z.enum(INTERACTION_EXPIRIES, { error: EXPIRY_RULE }).optional(),
      // The cap object IS the PATCH body, open so future fields ride it; the flag is typed so a
      // YAML-quoted "true" fails upfront in document validation, before any section writes.
      pull_request_creation_cap: z
        .object({
          enabled: z.boolean({
            error:
              'enabled must be an unquoted true or false (YAML parses "no"/"off"/"yes" as strings, not booleans), so the cap direction is unambiguous',
          }),
          max_open_pull_requests: z
            .int({ error: CAP_RULE })
            .min(1, CAP_RULE)
            .max(1000, CAP_RULE)
            .optional(),
        })
        .optional(),
      pull_request_creation_bypass: z.array(z.string()).optional(),
    },
    { error: unknownKeyError },
  )
  .superRefine((declared, refineCtx) => {
    // Checked in the shape so both modes fail before ANY section writes.
    if (
      declared.limit === undefined &&
      declared.expiry === undefined &&
      declared.pull_request_creation_cap === undefined &&
      declared.pull_request_creation_bypass === undefined
    ) {
      refineCtx.addIssue({
        code: "custom",
        message:
          "declare at least one of limit, pull_request_creation_cap, or pull_request_creation_bypass (or declare interaction_limits: null to clear the base limit)",
      });
    }
    if (declared.expiry !== undefined && declared.limit === undefined) {
      // GitHub rejects the base PUT body without a limit, and a run that never issues the PUT would
      // silently drop the expiry.
      refineCtx.addIssue({
        code: "custom",
        path: ["limit"],
        message:
          "expiry rides the base interaction-limits PUT, which requires a limit; declare limit alongside it, or remove expiry",
      });
    }
    const bypass = declared.pull_request_creation_bypass;
    if (bypass === undefined) {
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
    for (const login of bypass) {
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
