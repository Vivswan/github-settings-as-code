/** The `pages:` section's whole-section config declaration (see src/schema.ts). */

import { z } from "zod";

// Not exported: consumers spell it NonNullable<PagesConfig>. The definition id stays "PagesConfig";
// moving it onto the nullable wrapper would change the published schema.
const PagesSite = z
  .object({
    build_type: z.enum(["workflow", "legacy"]).optional(),
    source: z.object({ branch: z.string(), path: z.string().optional() }).optional(),
    cname: z.string().nullable().optional(),
    https_enforced: z.boolean().optional(),
    public: z.boolean().optional(),
  })
  .meta({ id: "PagesConfig" });

export const PagesConfig = PagesSite.nullable();
export type PagesConfig = z.infer<typeof PagesConfig>;
