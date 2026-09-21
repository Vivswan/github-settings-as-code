/** The `milestones:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

/**
 * A due date is a calendar day; the lens compares and snapshots the day, and the wire hook in index.ts sends it
 * as the instant GitHub keeps on that day. A timestamp is taken for its date part, so a file spelling one parses.
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
