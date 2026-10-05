/** The `collaborators:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";
import { PermissionSchema } from "../shared/roles.js";
import { open } from "../shared/schema-helpers.js";

export const CollaboratorConfig = open({
  username: z.string(),
  permission: PermissionSchema.optional(),
}).meta({ id: "CollaboratorConfig" });
export type CollaboratorConfig = z.infer<typeof CollaboratorConfig>;
