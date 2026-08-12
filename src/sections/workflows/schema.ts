/**
 * The `workflows:` entry-config declaration. The root src/schema.ts imports
 * it, keeps the SettingsFile property's array/describe call inline, and
 * re-exports the config so existing importers compile unchanged.
 */

import { z } from "zod";

export const WorkflowConfig = z
  .object({
    path: z.string().describe('Full ".github/workflows/ci.yml" or the bare "ci.yml" file name.'),
    state: z
      .enum(["active", "disabled"])
      .describe('Desired state; every live disabled_* variant counts as "disabled".'),
  })
  .describe(
    "One workflow's enable/disable state, keyed by its file path. Keys other than path and state are rejected (the enable/disable calls carry no payload, so an extra key could only be a typo).",
  )
  .meta({ id: "WorkflowConfig" });
export type WorkflowConfig = z.infer<typeof WorkflowConfig>;
