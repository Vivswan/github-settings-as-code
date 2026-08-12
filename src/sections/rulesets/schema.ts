/** The `rulesets:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const RulesetConfig = z
  .object({
    name: z.string().describe("The ruleset name, the natural key."),
    target: z
      .enum(["branch", "tag", "push"])
      .optional()
      .describe('What the ruleset applies to; defaults to "branch" upstream.'),
    enforcement: z
      .string()
      .optional()
      .describe('"active", "evaluate", or "disabled". Created rulesets default to "active".'),
    conditions: z
      .object({
        ref_name: z
          .object({
            include: z.array(z.string()).optional(),
            exclude: z.array(z.string()).optional(),
          })
          .optional()
          .describe("Short ref names are auto-prefixed (staging -> refs/heads/staging)."),
      })
      .optional()
      .describe("Which refs the ruleset covers."),
    rules: z
      .array(
        z.object({
          type: z.string(),
          parameters: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional()
      .describe("Rule list, passed through verbatim (future rule types included)."),
    bypass_actors: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Who may bypass the ruleset, passed through verbatim."),
  })
  .describe("One repository ruleset, matched to the live repo by name.")
  .meta({ id: "RulesetConfig" });
export type RulesetConfig = z.infer<typeof RulesetConfig>;
