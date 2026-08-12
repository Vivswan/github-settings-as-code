/** The agents_variables entry-config declaration (see index.ts for the section). */

import { z } from "zod";

export const AgentsVariableConfig = z
  .object({
    name: z
      .string()
      .describe(
        "The variable name, the natural key; case-insensitive (stored uppercased by GitHub).",
      ),
    value: z.string().describe("The plain-text value Copilot coding agents read."),
  })
  .describe("One Copilot agents repository variable, matched by case-insensitive name.")
  .meta({ id: "AgentsVariableConfig" });
export type AgentsVariableConfig = z.infer<typeof AgentsVariableConfig>;
