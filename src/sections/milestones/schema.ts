/** The `milestones:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const MilestoneConfig = z
  .object({
    title: z.string().describe("The milestone title, the natural key."),
    description: z.string().optional().describe("Longer explanation of the milestone."),
    state: z
      .enum(["open", "closed"])
      .optional()
      .describe("Open or closed; untouched unless declared."),
  })
  .describe("One milestone, matched by title.")
  .meta({ id: "MilestoneConfig" });
export type MilestoneConfig = z.infer<typeof MilestoneConfig>;
