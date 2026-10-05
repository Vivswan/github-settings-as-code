/** The `workflows:` section's schema slice; root src/schema.ts composes the SettingsFile property from it. */

import { z } from "zod";
import { open } from "../shared/schema-helpers.js";

const WorkflowConfig = open({
  path: z.string(),
  state: z.enum(["active", "disabled"]),
}).meta({ id: "WorkflowConfig" });

export const WorkflowsConfig = z.array(WorkflowConfig);
