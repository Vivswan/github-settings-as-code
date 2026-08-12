/** The `collaborators:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const CollaboratorConfig = z
  .object({
    username: z.string().describe("GitHub login, the natural key."),
    permission: z
      .string()
      .optional()
      .describe(
        '"pull", "triage", "push", "maintain", "admin", or a custom org role; defaults to "push".',
      ),
  })
  .describe(
    'One direct collaborator, matched by username. Keys other than username and permission are rejected (a misspelled "permission" would otherwise silently grant the default role).',
  )
  .meta({ id: "CollaboratorConfig" });
export type CollaboratorConfig = z.infer<typeof CollaboratorConfig>;
