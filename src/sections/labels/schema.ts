/** The `labels:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";
import { boundedString } from "../shared/schema-helpers.js";

// GitHub stores a color as exactly six hex digits: a name or CSS shorthand 422s on create, and on an existing label
// drifts and re-PATCHes every run, so both are refused here. The lens strips the optional "#" and folds the case.
const LabelColor = z
  .string()
  .regex(
    /^#?[0-9a-fA-F]{6}$/,
    'a label color is six hex digits, the leading "#" optional ("#d73a4a" or "d73a4a"); color names and three-digit shorthand are not accepted',
  );

/** GitHub counts the cap in characters (code points), as JSON Schema's maxLength does. */
const DESCRIPTION_MAX = 100;
const DESCRIPTION_CAP = `a label description is at most ${DESCRIPTION_MAX} characters (GitHub's cap)`;

const LabelDescription = boundedString(
  DESCRIPTION_MAX,
  "code points",
  (count) => `${DESCRIPTION_CAP}; this one has ${count}`,
);

export const LabelConfig = z
  .object({
    name: z.string(),
    color: LabelColor.optional(),
    description: LabelDescription.optional(),
    new_name: z.string().optional(),
  })
  .meta({ id: "LabelConfig" });
export type LabelConfig = z.infer<typeof LabelConfig>;
