/** The actions_variables entry-config declaration (see index.ts for the section). */

import type { z } from "zod";
import { variableConfig } from "../shared/schema-helpers.js";

export const ActionsVariableConfig = variableConfig("ActionsVariableConfig");
export type ActionsVariableConfig = z.infer<typeof ActionsVariableConfig>;
