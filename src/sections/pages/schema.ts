/** The `pages:` section's whole-section config declaration (see src/schema.ts). */

import type { components, operations } from "@octokit/openapi-types";
import { z } from "zod";

type PagesPutBody = NonNullable<
  operations["repos/update-information-about-pages-site"]["requestBody"]
>["content"]["application/json"];

/**
 * A site field the GET reports that the update PUT has no parameter for, so declared it would ride the
 * PUT ignored and diff against the live read on every run. `public` stays out: Enterprise Cloud sets it.
 */
type ReadOnlySiteField = Exclude<
  keyof components["schemas"]["page"],
  keyof PagesPutBody | "public"
>;

/** The fix each refusal names. */
const READ_ONLY_SITE_FIELDS = {
  url: "GitHub mints the API address from the repository",
  html_url:
    "GitHub mints the site address from the repository and `cname`; declare `cname` for a custom domain",
  status: "it reports the latest build's outcome",
  custom_404:
    "it reports whether the published site carries a 404.html; add that file to the source instead",
  protected_domain_state:
    "it reports the custom domain's verification; verify the domain in the owner's Pages settings",
  pending_domain_unverified_at: "it reports the custom domain's verification deadline",
  https_certificate:
    "GitHub provisions the certificate for `cname`; declare `cname` and `https_enforced`",
} satisfies Record<ReadOnlySiteField, string>;

// Not exported: consumers spell it NonNullable<PagesConfig>. The definition id stays "PagesConfig";
// moving it onto the nullable wrapper would change the published schema.
const PagesSite = z
  .object({
    build_type: z.enum(["workflow", "legacy"]).optional(),
    source: z.object({ branch: z.string(), path: z.enum(["/", "/docs"]).optional() }).optional(),
    cname: z.string().nullable().optional(),
    https_enforced: z.boolean().optional(),
    public: z.boolean().optional(),
  })
  .superRefine((site, refineCtx) => {
    // The strict type hides these keys; only the loosen()ed shape that parses documents lets them reach here.
    for (const [key, fix] of Object.entries(READ_ONLY_SITE_FIELDS)) {
      if ((site as Record<string, unknown>)[key] !== undefined) {
        refineCtx.addIssue({
          code: "custom",
          path: [key],
          message:
            "GitHub reports this field on the Pages site and the update has no such parameter, so the " +
            `value would be sent, ignored, and reported as drift on every run (${fix}); remove it`,
        });
      }
    }
  })
  .meta({
    id: "PagesConfig",
    // The published schema carries the same refusal, so an editor flags the key as the file is written.
    not: { anyOf: Object.keys(READ_ONLY_SITE_FIELDS).map((key) => ({ required: [key] })) },
  });

export const PagesConfig = PagesSite.nullable();
export type PagesConfig = z.infer<typeof PagesConfig>;
