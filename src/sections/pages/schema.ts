/** The `pages:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const PagesConfig = z
  .object({
    build_type: z
      .enum(["workflow", "legacy"])
      .optional()
      .describe('"workflow" (GitHub Actions) or "legacy" (branch).'),
    source: z
      .object({ branch: z.string(), path: z.string().optional() })
      .optional()
      .describe("The update PUT requires both branch and path when source is sent."),
    cname: z.string().nullable().optional().describe("Custom domain; null removes it."),
    https_enforced: z.boolean().optional().describe("Whether HTTPS is enforced for the site."),
    public: z
      .boolean()
      .optional()
      .describe(
        "Enterprise Cloud site visibility: true for public, false for repository members only. Documented only in the GHEC flavor of the Pages PUT; the GET echoes it everywhere.",
      ),
  })
  .describe("GitHub Pages site configuration; use `pages: null` to disable the site.")
  .meta({ id: "PagesConfig" });
export type PagesConfig = z.infer<typeof PagesConfig>;
