/** The `teams:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

const TeamConfig = z
  .object({
    name: z.string(),
    permission: z.string().optional(),
  })
  .meta({ id: "TeamConfig" });

export const TeamsConfig = z.array(TeamConfig);
