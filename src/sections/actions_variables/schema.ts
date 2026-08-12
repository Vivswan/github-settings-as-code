/** The actions_variables entry-config declaration (see index.ts for the section). */

import { z } from "zod";

export const ActionsVariableConfig = z
  .object({
    name: z
      .string()
      .describe(
        "The variable name, the natural key; case-insensitive (stored uppercased by GitHub).",
      ),
    value: z.string().describe("The plain-text value workflows read through the vars context."),
  })
  .describe("One GitHub Actions repository variable, matched by case-insensitive name.")
  .meta({ id: "ActionsVariableConfig" });
export type ActionsVariableConfig = z.infer<typeof ActionsVariableConfig>;
