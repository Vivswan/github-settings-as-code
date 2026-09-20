/** The agents_variables entry-config declaration (see index.ts for the section). */

import type { z } from "zod";
import { variableConfig } from "../shared/schema-helpers.js";

export const AgentsVariableConfig = variableConfig("AgentsVariableConfig");
export type AgentsVariableConfig = z.infer<typeof AgentsVariableConfig>;
