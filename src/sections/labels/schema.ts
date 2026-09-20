/** The `labels:` section's entry-config declaration (see src/schema.ts). */

import { z } from "zod";

// GitHub stores a color as exactly six hex digits: a name or CSS shorthand 422s on create, and on an existing label
// drifts and re-PATCHes every run, so both are refused here. The lens strips the optional "#" and folds the case.
const LabelColor = z
  .string()
  .regex(
    /^#?[0-9a-fA-F]{6}$/,
    'a label color is six hex digits, the leading "#" optional ("#d73a4a" or "d73a4a"); color names and three-digit shorthand are not accepted',
  );

const DESCRIPTION_CAP = "a label description is at most 100 characters (GitHub's cap)";

// zod's `.max()` runs on any value with a `length`, so a YAML mapping `{length: ...}` reached the comparison and
// threw; this check runs on strings alone, the type error alone reports anything else. zod counts code points.
const LabelDescription = z.string().check(
  new z.core.$ZodCheckMaxLength({
    check: "max_length",
    maximum: 100,
    when: (payload) => typeof payload.value === "string",
    error: (issue: { input: unknown }) =>
      `${DESCRIPTION_CAP}; this one has ${[...(issue.input as string)].length}`,
  }),
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
