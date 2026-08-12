/** The `labels:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const LabelConfig = z
  .object({
    name: z.string().describe("The label name, the natural key."),
    color: z.string().optional().describe('Hex color, with or without the leading "#".'),
    description: z.string().optional().describe("Short explanation shown in the label picker."),
    new_name: z.string().optional().describe("Probot compat: rename an existing label."),
  })
  .describe("One label, matched to the live repo by name.")
  .meta({ id: "LabelConfig" });
export type LabelConfig = z.infer<typeof LabelConfig>;
