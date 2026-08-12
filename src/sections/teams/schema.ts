/** The `teams:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const TeamConfig = z
  .object({
    name: z.string().describe("The team slug, the natural key."),
    permission: z
      .string()
      .optional()
      .describe('Same vocabulary as collaborators; defaults to "push".'),
  })
  .describe(
    'One org team\'s access to the repository, matched by team slug. Keys other than name and permission are rejected (a misspelled "permission" would otherwise silently grant the default role).',
  )
  .meta({ id: "TeamConfig" });
export type TeamConfig = z.infer<typeof TeamConfig>;

/** The `teams:` document slice: the entry list the document composes from. */
export const TeamsSlice = z.array(TeamConfig);
