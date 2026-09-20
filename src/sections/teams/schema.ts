/** The `teams:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";
import { PermissionSchema } from "../shared/roles.js";

// The name is the team_slug in every API path. A display name ("Core Team") probes /teams/Core%20Team, 404s, and the
// section reads that as "no access": check reports a lie and the grant PUT 404s in turn. Uppercase passes; GitHub
// folds the slug itself. The lookahead keeps "." and ".." out: as path segments they resolve to another URL entirely.
const SLUG_PATTERN = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._-]+$/;

function slugError(declared: string): string {
  const rule = `a team is declared by its slug (the name in its URL, /orgs/<org>/teams/<slug>): letters, digits, ".", "_", and "-" only, at least one letter or digit`;
  const guess = declared.trim().toLowerCase().replace(/\s+/g, "-");
  const shown = JSON.stringify(declared);
  return SLUG_PATTERN.test(guess) && guess !== declared
    ? `${rule}; a team named ${shown} usually has the slug "${guess}"`
    : `${rule}, and ${shown} is not one`;
}

export const TeamConfig = z
  .object({
    name: z.string().regex(SLUG_PATTERN, {
      error: (issue: { input: unknown }) => slugError(String(issue.input)),
    }),
    permission: PermissionSchema.optional(),
  })
  .meta({ id: "TeamConfig" });
export type TeamConfig = z.infer<typeof TeamConfig>;
