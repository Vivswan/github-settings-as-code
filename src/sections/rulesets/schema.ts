/** The `rulesets:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const RulesetConfig = z
  .object({
    name: z.string(),
    // The file may omit both: target takes the default GitHub documents for a create, enforcement the value chosen
    // here (the create requires one). The parsed entry carries both, so the PUT sends them and the comparison never
    // reads a live value under either key as omitted.
    target: z.enum(["branch", "tag", "push"]).default("branch"),
    enforcement: z.string().default("active"),
    conditions: z
      .object({
        ref_name: z
          .object({
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
    rules: z
      .array(
        z.object({
          type: z.string(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
    bypass_actors: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .meta({ id: "RulesetConfig" });
export type RulesetConfig = z.infer<typeof RulesetConfig>;
