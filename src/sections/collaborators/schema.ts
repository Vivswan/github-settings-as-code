/** The `collaborators:` section's entry-config declaration (see src/schema.ts). */

import type { z } from "zod";
import { PermissionSchema } from "../shared/roles.js";
import { open, pathSegmentName } from "../shared/schema-helpers.js";

export const CollaboratorConfig = open({
  username: pathSegmentName("the username of a collaborator"),
  permission: PermissionSchema.optional(),
}).meta({ id: "CollaboratorConfig" });
export type CollaboratorConfig = z.infer<typeof CollaboratorConfig>;
