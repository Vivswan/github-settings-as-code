/** The `autolinks:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

// GitHub's own charset for a prefix; the create 422s on anything else, so the document refuses it first.
const KEY_PREFIX = /^[A-Za-z0-9.\-_+=:/#]+$/;

export const AutolinkConfig = z
  .object({
    key_prefix: z.string().regex(KEY_PREFIX, {
      error: (issue) =>
        issue.input === ""
          ? 'key_prefix is empty; it is the text GitHub matches before the reference number, e.g. "TICKET-"'
          : `key_prefix ${JSON.stringify(issue.input)} may only contain letters, digits, and . - _ + = : / #, which is all GitHub accepts; remove the other characters`,
    }),
    url_template: z.string().includes("<num>", {
      error: (issue) =>
        `url_template ${JSON.stringify(issue.input)} has no "<num>" placeholder, so GitHub rejects the create; put "<num>" where the reference number goes, e.g. ${JSON.stringify(`${String(issue.input)}/<num>`)}`,
    }),
    is_alphanumeric: z.boolean().optional(),
  })
  .meta({ id: "AutolinkConfig" });
export type AutolinkConfig = z.infer<typeof AutolinkConfig>;
