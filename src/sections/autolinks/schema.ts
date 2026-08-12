/** The `autolinks:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

export const AutolinkConfig = z
  .object({
    key_prefix: z
      .string()
      .describe('Text prefix that triggers the link (e.g. "TICKET-"), the natural key.'),
    url_template: z.string().describe('Target URL template containing "<num>".'),
    is_alphanumeric: z
      .boolean()
      .optional()
      .describe("Whether <num> also matches letters; upstream default is true."),
  })
  .describe("One autolink reference, matched by key prefix.")
  .meta({ id: "AutolinkConfig" });
export type AutolinkConfig = z.infer<typeof AutolinkConfig>;
