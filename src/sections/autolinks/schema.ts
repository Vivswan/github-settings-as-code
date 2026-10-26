/** The `autolinks:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";
import { open } from "../shared/schema-helpers.js";

const KEY_PREFIX = /^[A-Za-z0-9.\-_+=:/#]+$/;

export const AutolinkConfig = open({
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
}).meta({ id: "AutolinkConfig" });
export type AutolinkConfig = z.infer<typeof AutolinkConfig>;
