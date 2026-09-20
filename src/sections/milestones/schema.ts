/** The `milestones:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

/**
 * GitHub keeps only the calendar day of a due date, so the day is the declaration; a full timestamp is
 * taken for its date part, since a snapshot reads the stored day back in the timestamp form GitHub echoes.
 */
const DueOn = z.union([z.iso.date(), z.iso.datetime()], {
  error:
    "due_on is a calendar day, YYYY-MM-DD (or an ISO 8601 UTC timestamp, YYYY-MM-DDTHH:MM:SSZ, whose time GitHub discards)",
});

export const MilestoneConfig = z
  .object({
    title: z.string(),
    description: z.string().optional(),
    state: z.enum(["open", "closed"]).optional(),
    due_on: DueOn.optional(),
  })
  .meta({ id: "MilestoneConfig" });
export type MilestoneConfig = z.infer<typeof MilestoneConfig>;
