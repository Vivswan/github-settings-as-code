/** The `milestones:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";
import { MILESTONE_STATES } from "../../generated/spec-enums.js";
import { open } from "../shared/schema-helpers.js";

// A calendar day: the lens compares and snapshots the day and the wire hook in index.ts sends the instant GitHub keeps on it, so a timestamp is taken for its date part alone.
const DueOn = z.union([z.iso.date(), z.iso.datetime()], {
  error:
    "due_on is a calendar day, YYYY-MM-DD (or an ISO 8601 UTC timestamp, YYYY-MM-DDTHH:MM:SSZ, whose time GitHub discards)",
});

/** title is the identity, matched exactly (index.ts): two titles differing in case are two milestones. */
export const MilestoneConfig = open({
  title: z.string(),
  description: z.string().optional(),
  state: z.enum(MILESTONE_STATES).optional(),
  due_on: DueOn.optional(),
}).meta({ id: "MilestoneConfig" });

export type MilestoneConfig = z.infer<typeof MilestoneConfig>;
