/** The `milestones:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

/**
 * A due date is a calendar day; the fold to the day GitHub keeps is DueOnWire in index.ts. A timestamp is
 * taken for its date part, so the noon-UTC form a snapshot emits (YYYY-MM-DDT12:00:00Z) parses again.
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
