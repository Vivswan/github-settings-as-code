/** The `custom_properties:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";
import { open } from "../shared/schema-helpers.js";

export const CustomPropertyConfig = open({
  property_name: z.string(),
  value: z.union([z.string(), z.array(z.string()), z.boolean(), z.number(), z.null()]),
}).meta({ id: "CustomPropertyConfig" });
export type CustomPropertyConfig = z.infer<typeof CustomPropertyConfig>;
